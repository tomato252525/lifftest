import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'

(function () {
    const liffId = '2008402680-n8rP92vY';
    const supabaseUrl = 'https://uxpyevttkvycivvvqycl.supabase.co';
    const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV4cHlldnR0a3Z5Y2l2dnZxeWNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzNzYzNTQsImV4cCI6MjA3ODk1MjM1NH0.oJL3eCCwqJ1TK6ysJkllqYVrm2NhZmo-lMCdUm3_840';

    let db = null;
    let currentUserId = null;
    let currentOffset = 1; // デフォルトは来週(1)

    // 日付計算 (offsetWeeks: 0=今週, 1=来週...)
    const getMondayDate = (offsetWeeks) => {
        const nowJST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
        const dayOfWeek = nowJST.getDay();
        const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        const targetDate = new Date(nowJST);
        targetDate.setDate(nowJST.getDate() - diffToMonday + (offsetWeeks * 7)); // オフセット反映

        const y = targetDate.getFullYear();
        const m = String(targetDate.getMonth() + 1).padStart(2, '0');
        const d = String(targetDate.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    };

    // データ取得 (引数で offset を受け取る)
    const fetchAdminData = async (offset) => {
        const targetMonday = getMondayDate(offset);
        currentOffset = offset; // 現在のオフセットを保存

        // 1. ユーザー
        const { data: users, error: uErr } = await db
            .from('users')
            .select('id, name, role')
            .eq('role', 'cast')
            .eq('is_active', true)
            .order('name');
        if (uErr) throw uErr;

        // 2. 部屋
        const { data: rooms, error: roomErr } = await db
            .from('rooms')
            .select('id, name, room_type')
            .eq('is_active', true)
            .order('room_type', { ascending: true })
            .order('id', { ascending: true });
        if (roomErr) throw roomErr;

        // 3. シフト希望 (targetMonday 週)
        const { data: requests, error: rErr } = await db
            .from('shift_requests')
            .select('user_id, date, start_time, end_time, is_available, exit_by_end_time')
            .eq('week_start_date', targetMonday);
        if (rErr) throw rErr;

        // 4. 確定シフト (targetMonday 週)
        const { data: confirmed, error: cErr } = await db
            .from('confirmed_shifts')
            .select('id, cast_id, date, start_time, end_time, state, exit_by_end_time, note, room_id')
            .eq('week_start_date', targetMonday);
        if (cErr) throw cErr;

        // 5. 公開状態 (targetMonday 週)
        const { data: publishStatus, error: pErr } = await db
            .from('shift_publish_status')
            .select('is_published')
            .eq('week_start_date', targetMonday)
            .maybeSingle();
        if (pErr) throw pErr;

        return {
            target_week_start_date: targetMonday,
            is_published: publishStatus?.is_published || false,
            week_offset: offset, // Elm側でUI制御に使うため渡す
            users: users || [],
            rooms: rooms || [],
            requests: requests || [],
            confirmed_shifts: confirmed || []
        };
    };

    window.addEventListener('DOMContentLoaded', () => {
        const node = document.getElementById('root');
        const app = Elm.Main.init({ node });

        const sendError = (e) => {
            console.error(e);
            app.ports.deliverError?.send(typeof e === 'string' ? e : e?.message || 'Unknown error');
        };

        // ----------------------------------
        // Port: 週切り替えリクエスト (NEW)
        // ----------------------------------
        app.ports.changeWeekRequest?.subscribe(async (offset) => {
            if (!db) return;
            try {
                const data = await fetchAdminData(offset);
                app.ports.deliverAdminData.send({ currentUser: { id: currentUserId, name: 'Admin', role: 'admin' }, data: data });
            } catch (e) {
                sendError(e);
            }
        });

        // シフト保存・公開
        app.ports.publishShiftsRequest?.subscribe(async (payload) => {
            if (!db || !currentUserId) return;
            try {
                const { week_start_date, shifts } = payload;

                const shiftsToUpsert = shifts.map(s => ({
                    cast_id: s.cast_id,
                    date: s.date,
                    week_start_date: week_start_date,
                    start_time: s.start_time,
                    end_time: s.end_time,
                    state: s.state,
                    exit_by_end_time: s.exit_by_end_time,
                    note: s.note || '',
                    room_id: s.room_id,
                    manager_id: currentUserId
                }));

                const { error: shiftError } = await db
                    .from('confirmed_shifts')
                    .upsert(shiftsToUpsert, { onConflict: 'cast_id,date' });
                if (shiftError) throw shiftError;

                const { error: pubError } = await db
                    .from('shift_publish_status')
                    .upsert({ week_start_date: week_start_date, is_published: true }, { onConflict: 'week_start_date' });
                if (pubError) throw pubError;

                // 保存後は現在のオフセットで再取得
                const newData = await fetchAdminData(currentOffset);
                app.ports.publishShiftsResponse?.send(newData);
            } catch (e) {
                sendError(e);
            }
        });

        // 認証・初期化
        liff.init({ liffId, withLoginOnExternalBrowser: true }).then(async () => {
            if (!liff.isLoggedIn()) { liff.login(); return; }
            const idToken = liff.getIDToken();

            try {
                const response = await fetch(`${supabaseUrl}/functions/v1/verify-liff-token`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseAnonKey}` },
                    body: JSON.stringify({ idToken })
                });
                const result = await response.json();

                if (!response.ok) {
                    const errorMessage = result.error || result.message || 'Token verification failed';
                    if (errorMessage === 'id_token_expired') {
                        const url = new URL(location.href);
                        if (url.searchParams.get('relogin') !== '1') {
                            await liff.logout();
                            url.searchParams.set('relogin', '1');
                            location.href = url.toString();
                            return;
                        } else {
                            sendError('ログイン情報の有効期限が切れています。ブラウザを閉じて再度お試しください。');
                            return;
                        }
                    }
                    sendError(`検証エラー: ${errorMessage}`);
                    return;
                }

                const user = result.user;
                if (user.role !== 'admin') { sendError('管理者権限がありません。'); return; }

                currentUserId = user.id;
                db = createClient(supabaseUrl, supabaseAnonKey, { global: { headers: { Authorization: `Bearer ${result.token}` } } });

                // 初期表示は「来週(1)」を表示
                const adminData = await fetchAdminData(1);
                app.ports.deliverAdminData.send({ currentUser: user, data: adminData });
            } catch (e) {
                sendError(e);
            }
        });
    });
})();