import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.86.0/+esm'

(function () {
    const liffId = '2008402680-n8rP92vY';
    const supabaseUrl = 'https://uxpyevttkvycivvvqycl.supabase.co';
    const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV4cHlldnR0a3Z5Y2l2dnZxeWNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzNzYzNTQsImV4cCI6MjA3ODk1MjM1NH0.oJL3eCCwqJ1TK6ysJkllqYVrm2NhZmo-lMCdUm3_840';

    let db = null;
    let currentUserId = null;
    let isInClient = false;

    // 日付計算
    const getMondayDate = (offsetWeeks) => {
        const nowJST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
        const dayOfWeek = nowJST.getDay();
        const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        const targetDate = new Date(nowJST);
        targetDate.setDate(nowJST.getDate() - diffToMonday + (offsetWeeks * 7));

        const y = targetDate.getFullYear();
        const m = String(targetDate.getMonth() + 1).padStart(2, '0');
        const d = String(targetDate.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    };

    // データ取得
    const loadInitialScheduleData = async () => {
        const currentMonday = getMondayDate(0);
        const nextMonday = getMondayDate(1);
        // 今週と来週の月曜リスト (クエリ結合用)
        const targetMondays = [currentMonday, nextMonday];

        // 全てのデータを並列で取得
        const [
            usersResult,
            requestsResult,
            confirmedResult,
            roomsResult,
            publishStatusResult
        ] = await Promise.all([
            // 1. ユーザー
            db.from('users')
                .select('id, name, note')
                .eq('role', 'cast')
                .eq('is_active', true)
                .order('name'),

            // 2. 希望シフト (今週・来週まとめて取得)
            db.from('shift_requests')
                .select('user_id, date, start_time, end_time, exit_by_end_time, is_available')
                .in('week_start_date', targetMondays)
                .order('date', { ascending: true }),

            // 3. 確定シフト (今週・来週まとめて取得)
            db.from('confirmed_shifts')
                .select('id, cast_id, date, start_time, end_time, state, exit_by_end_time, note, room_id')
                .in('week_start_date', targetMondays)
                .order('date', { ascending: true }),

            // 4. 部屋一覧
            db.from('rooms')
                .select('id, name')
                .eq('is_active', true)
                .order('id', { ascending: true }),

            // 5. 公開状態 (ターゲットは来週分で固定)
            db.from('shift_publish_status')
                .select('is_published')
                .eq('week_start_date', nextMonday)
                .maybeSingle()
        ]);

        if (usersResult.error) throw usersResult.error;
        if (requestsResult.error) throw requestsResult.error;
        if (confirmedResult.error) throw confirmedResult.error;
        if (roomsResult.error) throw roomsResult.error;
        if (publishStatusResult.error) throw publishStatusResult.error;

        const createScheduleMap = () => {
            const map = {};

            // 希望シフトのマッピング
            requestsResult.data.forEach(req => {
                if (!map[req.user_id]) map[req.user_id] = {};

                const requestData = req.is_available
                    ? {
                        type: 'Available',
                        startTime: req.start_time,
                        endTime: req.end_time,
                        exitByEndTime: req.exit_by_end_time
                    }
                    : { type: 'Holiday' };

                map[req.user_id][req.date] = {
                    request: requestData,
                    confirmedShift: null // 初期値
                };
            });

            // 確定シフトのマッピング
            confirmedResult.data.forEach(shift => {
                if (!map[shift.cast_id]) map[shift.cast_id] = {};
                // 希望が出てない日に確定シフトがある場合のガード
                if (!map[shift.cast_id][shift.date]) {
                    map[shift.cast_id][shift.date] = { request: { type: 'NoData' }, confirmedShift: null };
                }

                map[shift.cast_id][shift.date].confirmedShift = {
                    id: shift.id,
                    startTime: shift.start_time,
                    endTime: shift.end_time,
                    roomId: shift.room_id,
                    note: shift.note,
                    state: shift.state
                };
            });

            return map;
        };

        const scheduleMap = createScheduleMap();

        const formattedUsers = usersResult.data.map(u => ({
            id: u.id,
            name: u.name,
            note: u.note,
            schedule: scheduleMap[u.id] || {}
        }));

        return {
            users: formattedUsers,
            rooms: roomsResult.data,
            publishStatus: publishStatusResult.data
        };
    };

    window.addEventListener('DOMContentLoaded', () => {
        const node = document.getElementById('root');
        const app = Elm.Main.init({ node });

        const sendError = (e) => {
            console.error(e);
            app.ports.deliverError?.send(typeof e === 'string' ? e : e?.message || 'Unknown error');
        };

        app.ports.refreshDataRequest?.subscribe(async () => {
            if (!db || !currentUserId) {
                sendError('DB client or user ID is not available');
                return;
            }

            try {
                const result = await loadInitialScheduleData();
                app.ports.refreshDataResponse?.send({
                    ...result,
                    isInClient
                });
            } catch (e) {
                sendError(e);
            }
        });

        // 認証・初期化処理
        liff.init({
            liffId,
            withLoginOnExternalBrowser: true
        }).then(async () => {
            if (!liff.isLoggedIn()) {
                liff.login();
                return;
            }
            const idToken = liff.getIDToken();
            if (!idToken) {
                sendError('IDトークンを取得できませんでした。');
                return;
            }

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

                if (result.user.role !== 'admin') { sendError('管理者権限がありません。'); return; }

                currentUserId = result.user.id;
                isInClient = liff.isInClient();
                db = createClient(supabaseUrl, supabaseAnonKey, {
                    auth: { persistSession: false },
                    global: { headers: { Authorization: `Bearer ${result.token}` } },
                });

                const resultData = await loadInitialScheduleData();
                app.ports.deliverVerificationResult.send({
                    ...resultData,
                    isInClient
                });
            } catch (e) {
                sendError(e);
            }
        });
    });
})();
