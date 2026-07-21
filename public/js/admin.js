(function() {
    'use strict';

    let isRedirecting = false;

    if (!localStorage.getItem('kms_token') && !window.location.pathname.includes('/login')) {
        window.location.href = '/login';
        return;
    }

    let csrfToken = null;
    let csrfFetchPromise = null;

    function redirectToLogin() {
        if (isRedirecting) {
            return;
        }
        isRedirecting = true;
        localStorage.removeItem('kms_token');
        localStorage.removeItem('kms_user');
        sessionStorage.clear();
        
        document.cookie.split(";").forEach(function(c) {
            document.cookie = c.replace(/^ +/, "")
                .replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
        });
        
        window.location.href = '/login';
    }

    async function fetchCsrfToken() {
        if (csrfFetchPromise) {
            return csrfFetchPromise;
        }

        csrfFetchPromise = (async () => {
            try {
                const response = await fetch('/api/csrf-token', {
                    credentials: 'include',
                    headers: { 'Accept': 'application/json' }
                });
                if (response.ok) {
                    const data = await response.json();
                    csrfToken = data.csrfToken;
                    const meta = document.querySelector('meta[name="csrf-token"]');
                    if (meta) meta.setAttribute('content', csrfToken);
                    return csrfToken;
                }
                console.error('Failed to fetch CSRF token:', response.status);
                return null;
            } catch (error) {
                console.error('Error fetching CSRF token:', error);
                return null;
            } finally {
                csrfFetchPromise = null;
            }
        })();

        return csrfFetchPromise;
    }

    async function getCsrfToken() {
        if (csrfToken) return csrfToken;
        return await fetchCsrfToken();
    }

    async function refreshCsrfToken() {
        csrfToken = null;
        csrfFetchPromise = null;
        return await fetchCsrfToken();
    }

    function getToken() {
        return localStorage.getItem('kms_token');
    }

    function getUser() {
        try { return JSON.parse(localStorage.getItem('kms_user')); } catch { return null; }
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;');
    }

    function formatDate(iso) {
        if (!iso) return '—';
        return new Date(iso).toLocaleString('en-SG', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    function formatDateShort(iso) {
        if (!iso) return '—';
        return new Date(iso).toLocaleDateString('en-SG', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    }

    function updateNumber(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    }

    function safeLower(value) {
        return (value ?? '').toString().toLowerCase();
    }

    function toArray(value) {
        if (Array.isArray(value)) return value;
        if (typeof value === 'string') return value.split(',').map(s => s.trim()).filter(Boolean);
        if (value && typeof value === 'object') {
            if (Array.isArray(value.permissions)) return value.permissions;
            if (Array.isArray(value.roles)) return value.roles;
            if (Array.isArray(value.permission_codes)) return value.permission_codes;
            return [];
        }
        return [];
    }

    function getInitials(name) {
        if (!name) return '?';
        const parts = name.trim().split(/\s+/);
        if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
        return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
    }

    function getAvatarColor(name) {
        if (!name) return 'hsl(0,70%,80%)';
        let h = 0;
        for (let i = 0; i < name.length; i++) {
            h = name.charCodeAt(i) + ((h << 5) - h);
        }
        return `hsl(${Math.abs(h % 360)},70%,80%)`;
    }

    function formatLastActive(iso) {
        if (!iso) return 'Never';
        return new Date(iso).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        }) + ' at ' + new Date(iso).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    function safeNumber(value, fallback = 0) {
        const num = parseFloat(value);
        return isNaN(num) ? fallback : num;
    }

    async function authenticatedFetch(url, options = {}) {
        const token = getToken();
        if (!token) {
            if (!isRedirecting) {
                redirectToLogin();
            }
            throw new Error('No authentication token found. Please log in again.');
        }

        let csrf = await getCsrfToken();
        if (!csrf) csrf = '';

        const headers = {
            'Authorization': `Bearer ${token}`,
            'X-CSRF-Token': csrf,
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'application/json',
            ...options.headers
        };

        if (options.body && !(options.body instanceof FormData)) {
            headers['Content-Type'] = 'application/json';
        }

        if (options.body instanceof FormData) {
            delete headers['Content-Type'];
        }

        const fetchOptions = {
            ...options,
            headers,
            credentials: 'include'
        };

        if (options.method === 'GET') {
            delete fetchOptions.body;
        }

        try {
            let response = await fetch(url, fetchOptions);

            if (response.status === 403) {
                const errorData = await response.json().catch(() => ({}));
                if (errorData.error === 'Invalid CSRF token' || errorData.code === 'INVALID_CSRF') {
                    const newCsrf = await refreshCsrfToken();
                    if (newCsrf) {
                        headers['X-CSRF-Token'] = newCsrf;
                        const retryOptions = { ...fetchOptions, headers };
                        response = await fetch(url, retryOptions);
                    }
                }
            }

            if (response.status === 401) {
                if (!isRedirecting) {
                    redirectToLogin();
                }
                throw new Error('Your session has expired. Please log in again.');
            }

            return response;
        } catch (err) {
            if (err.name === 'TypeError' && err.message.includes('fetch')) {
                throw new Error('Unable to connect to the server. Please check your internet connection and try again.');
            }
            throw err;
        }
    }

    function showToast(message, type = 'success') {
        let root = document.getElementById('toastRoot');
        if (!root) {
            root = document.createElement('div');
            root.id = 'toastRoot';
            document.body.appendChild(root);
        }
        const toast = document.createElement('div');
        toast.className = 'toast-notification';
        toast.textContent = message;
        toast.style.background = type === 'error' ? '#EF4444' : type === 'warning' ? '#F59E0B' : '#1E293B';
        root.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }

    function showAlertModal(message, type = 'success', title = null) {
        const modal = document.getElementById('alertModal');
        const icon = document.getElementById('alertIcon');
        const titleEl = document.getElementById('alertTitle');
        const msgEl = document.getElementById('alertMessage');
        
        icon.className = 'alert-icon';
        const titles = {
            success: 'Success',
            error: 'Error',
            warning: 'Warning',
            info: 'Information'
        };
        
        const icons = {
            success: 'fa-check-circle',
            error: 'fa-times-circle',
            warning: 'fa-exclamation-triangle',
            info: 'fa-info-circle'
        };
        
        const classes = {
            success: 'success',
            error: 'error',
            warning: 'warning',
            info: 'info'
        };
        
        icon.classList.add(classes[type] || 'success');
        icon.innerHTML = `<i class="fas ${icons[type] || icons.success}"></i>`;
        titleEl.textContent = title || titles[type] || 'Notice';
        msgEl.textContent = message;
        
        modal.classList.add('active');
    }

    function closeAlertModal() {
        document.getElementById('alertModal').classList.remove('active');
    }

    function showDetailModal(title, contentHtml) {
        document.getElementById('detailModalTitle').innerText = title;
        document.getElementById('detailModalContent').innerHTML = contentHtml;
        document.getElementById('detailModal').style.display = 'flex';
    }

    function closeDetailModal() {
        document.getElementById('detailModal').style.display = 'none';
    }

    function updateUserDisplay() {
        const user = getUser();
        if (user) {
            const displayName = user.name || 'User';
            document.getElementById('userDisplay').textContent = displayName;
            document.getElementById('dropdownUserName').textContent = displayName;
            const initials = getInitials(displayName);
            document.getElementById('userAvatar').textContent = initials;
            document.getElementById('dropdownAvatar').textContent = initials;
        }
    }

    async function refreshUserProfile() {
        try {
            const token = getToken();
            if (!token) return;
            
            const res = await fetch('/api/user/profile', {
                credentials: 'include',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/json'
                }
            });
            
            if (res.ok) {
                const data = await res.json();
                const user = getUser() || {};
                user.name = data.name || user.name || 'User';
                user.email = data.email || user.email;
                user.role = data.role || user.role || 'user';
                localStorage.setItem('kms_user', JSON.stringify(user));
                updateUserDisplay();
                return true;
            }
            return false;
        } catch (err) {
            console.error('Failed to refresh user profile:', err);
            return false;
        }
    }

    function openProfileModal() {
        const user = getUser();
        if (user) {
            authenticatedFetch('/api/user/profile')
                .then(res => res.json())
                .then(data => {
                    document.getElementById('profileName').value = data.name || '';
                    document.getElementById('profileEmail').value = data.email || '';
                    document.getElementById('profileCurrentPassword').value = '';
                    document.getElementById('profilePassword').value = '';
                })
                .catch(() => {
                    document.getElementById('profileName').value = user.name || '';
                    document.getElementById('profileEmail').value = user.email || '';
                });
        }
        document.getElementById('profileModal').style.display = 'flex';
        const userDropdown = document.getElementById('userDropdown');
        const profileBtn = document.getElementById('userProfileBtn');
        if (userDropdown) userDropdown.classList.remove('show');
        if (profileBtn) profileBtn.classList.remove('open');
        const mobileMenu = document.getElementById('mobileMenu');
        if (mobileMenu) mobileMenu.classList.remove('open');
    }

    function printSection(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;
        const clone = container.cloneNode(true);
        clone.querySelectorAll('.btn-print').forEach(el => el.remove());
        const header = clone.querySelector('.card-header');
        if (header) {
            const actions = header.querySelectorAll('.btn-print, .btn-manage, .btn-refresh, input, select, button');
            actions.forEach(el => el.remove());
        }
        const filterRows = clone.querySelectorAll('.grid, .search-bar, .flex.gap-2.justify-end');
        filterRows.forEach(el => el.remove());

        const styles = document.querySelector('style')?.innerHTML || '';
        const printWin = window.open('', '_blank', 'width=1200,height=800');
        printWin.document.write(`
            <!DOCTYPE html>
            <html>
            <head><title>Print</title>
            <style>
                * { box-sizing: border-box; }
                body { font-family: 'Inter', sans-serif; background: white; padding: 2rem; }
                .container { max-width: 1200px; margin: 0 auto; }
                .card-header { background: #f8fafc; padding: 0.75rem 1.125rem; border-bottom: 2px solid #d4a843; }
                .card-header h3 { margin: 0; font-size: 1rem; }
                .card-body { padding: 1rem 1.125rem; }
                table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
                th { background: #f1f5f9; text-align: left; padding: 0.5rem; border-bottom: 2px solid #e2e8f0; }
                td { padding: 0.5rem; border-bottom: 1px solid #e2e8f0; }
                .status-badge { padding: 0.1rem 0.6rem; border-radius: 40px; font-size: 0.7rem; display: inline-block; }
                .no-print { display: none !important; }
                @page { margin: 1.5cm; }
                ${styles}
            </style>
            </head>
            <body>
                <div class="container">${clone.outerHTML}</div>
                <script>
                    window.onload = function() { window.print(); window.close(); };
                <\/script>
            </body>
            </html>
        `);
        printWin.document.close();
    }

    async function checkAuth() {
        try {
            const token = getToken();
            if (!token) {
                if (!isRedirecting) {
                    redirectToLogin();
                }
                return false;
            }

            const response = await fetch('/api/auth/check-session', {
                credentials: 'include',
                headers: { 'Accept': 'application/json' }
            });

            if (!response.ok) {
                if (!isRedirecting) {
                    redirectToLogin();
                }
                return false;
            }

            const data = await response.json();

            if (!data.authenticated) {
                if (!isRedirecting) {
                    redirectToLogin();
                }
                return false;
            }

            if (data.user) {
                try {
                    const profileRes = await fetch('/api/user/profile', {
                        credentials: 'include',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Accept': 'application/json'
                        }
                    });
                    if (profileRes.ok) {
                        const profileData = await profileRes.json();
                        data.user.name = profileData.name || data.user.name || 'User';
                        data.user.email = profileData.email || data.user.email;
                        data.user.role = profileData.role || data.user.role || 'user';
                    }
                } catch (profileErr) {
                    if (!data.user.name) {
                        data.user.name = 'User';
                    }
                }
                
                if (!data.user.name || data.user.name.trim() === '') {
                    data.user.name = 'User';
                }
                
                localStorage.setItem('kms_user', JSON.stringify(data.user));
            }

            if (data.user.role !== 'admin') {
                const accessDenied = document.getElementById('accessDenied');
                const loadingContainer = document.getElementById('loadingContainer');
                if (accessDenied) accessDenied.style.display = 'flex';
                if (loadingContainer) loadingContainer.style.display = 'none';
                return false;
            }

            return true;
        } catch (error) {
            console.error('Auth check failed:', error);
            if (!isRedirecting) {
                redirectToLogin();
            }
            return false;
        }
    }

    async function logAuditEvent(action, targetType, targetId, details = {}, oldData = null, newData = null) {
        try {
            const user = getUser();
            await authenticatedFetch('/api/audit/log', {
                method: 'POST',
                body: JSON.stringify({
                    action: action,
                    target_type: targetType,
                    target_id: targetId,
                    details: details,
                    old_data: oldData,
                    new_data: newData,
                    user_name: user?.name || 'System',
                    user_email: user?.email || 'system'
                })
            });
        } catch (err) {
            console.error('Failed to log audit event:', err);
        }
    }

    let allTransactions = [];
    let filteredTransactions = [];
    let txPage = 1, txRows = 10, txTotal = 0;

    let inventoryData = [];
    let filteredInventory = [];
    let invPage = 1, invRows = 10, invTotal = 0;

    let manageKeyData = [];
    let manageKeyFiltered = [];
    let manageKeyPage = 1, manageKeyRows = 8, manageKeyTotal = 0;

    let permissionsData = { roles: [], permissions: [], roleMappings: {} };
    let allRolesList = [];
    let emailTabLoaded = false;
    let securityLoaded = false;
    let _lostKeysListenerAttached = false;
    let currentAction = null;
    let currentRequestId = null;
    let pendingLostTransaction = null;

    async function loadTransactions() {
        const giver = document.getElementById('filterGiver')?.value.trim() || '';
        const receiver = document.getElementById('filterReceiver')?.value.trim() || '';
        const branch = document.getElementById('filterBranch')?.value.trim() || '';
        const action = document.getElementById('filterAction')?.value.trim() || '';
        const status = document.getElementById('filterStatus')?.value || '';
        const from = document.getElementById('filterFrom')?.value || '';
        const to = document.getElementById('filterTo')?.value || '';

        const params = new URLSearchParams();
        if (giver) params.append('giver', giver);
        if (receiver) params.append('receiver', receiver);
        if (branch) params.append('branch', branch);
        if (action) params.append('action', action);
        if (status) params.append('status', status);
        if (from) params.append('from', from);
        if (to) params.append('to', to);

        const url = `/api/admin/transactions${params.toString() ? '?' + params.toString() : ''}`;
        try {
            const res = await authenticatedFetch(url);
            const data = await res.json();
            allTransactions = data;
            applyTransactionFilters();
            updateMetrics(data);
            window._activeBorrowsData = data.filter(t => t.status === 'borrowed');
        } catch (err) {
            document.getElementById('transactionsTableBody').innerHTML = '<tr><td colspan="10" class="text-center py-8 text-slate-400">Unable to load transactions. Please refresh the page.</td></tr>';
            showAlertModal(err.message || 'Failed to load transactions. Please check your network.', 'error');
        }
    }

    function applyTransactionFilters() {
        filteredTransactions = allTransactions;
        txTotal = filteredTransactions.length;
        renderTransactionsTable();
        updateTransactionPagination();
    }

    function renderTransactionsTable() {
        const tbody = document.getElementById('transactionsTableBody');
        const start = (txPage - 1) * txRows;
        const end = Math.min(start + txRows, txTotal);
        const pageData = filteredTransactions.slice(start, end);
        if (!pageData.length) {
            tbody.innerHTML = '<tr><td colspan="10" class="text-center py-8 text-slate-400">No transactions found.</td></tr>';
            return;
        }
        let html = '';
        for (const tx of pageData) {
            const statusClass = tx.status === 'borrowed' ? 'borrowed' : tx.status === 'returned' ? 'returned' : tx.status === 'lost' ? 'lost' : '';
            html += `<tr>
                <td>${escapeHtml(tx.id)}</td>
                <td>${escapeHtml(tx.giver_signature_name || '—')}</td>
                <td>${escapeHtml(tx.receiver_signature_name || '—')}</td>
                <td>${escapeHtml(tx.key_code || '—')}</td>
                <td>${escapeHtml(tx.quantity)}</td>
                <td>${tx.action === 'borrow' ? 'Withdraw' : 'Return'}</td>
                <td>${formatDate(tx.borrowed_at)}</td>
                <td>${formatDate(tx.returned_at)}</td>
                <td><span class="status-badge ${statusClass}">${tx.status}</span></td>
                <td>${escapeHtml(tx.reason || '—')}</td>
            </tr>`;
        }
        tbody.innerHTML = html;
    }

    function updateTransactionPagination() {
        const totalPages = Math.ceil(txTotal / txRows) || 1;
        const start = (txPage - 1) * txRows + 1;
        const end = Math.min(txPage * txRows, txTotal);
        document.getElementById('transactionsPaginationInfo').innerText = txTotal === 0 ? 'Showing 0 of 0 transactions' : `Showing ${start}–${end} of ${txTotal} transactions`;
        document.getElementById('transactionsPrevPageBtn').disabled = txPage === 1 || txTotal === 0;
        document.getElementById('transactionsNextPageBtn').disabled = txPage >= totalPages || txTotal === 0;
    }

    function updateMetrics(transactions) {
        const active = transactions.filter(t => t.status === 'borrowed');
        updateNumber('borrowedCount', active.length);
        const withReturn = transactions.filter(t => t.status === 'borrowed' && t.planned_return);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const overdue = withReturn.filter(t => {
            const d = new Date(t.planned_return);
            d.setHours(0, 0, 0, 0);
            return d < today;
        });
        const dueToday = withReturn.filter(t => {
            const d = new Date(t.planned_return);
            d.setHours(0, 0, 0, 0);
            return d.getTime() === today.getTime();
        });
        updateNumber('overdueCount', overdue.length + dueToday.length);
        let next = null;
        if (withReturn.length) {
            next = withReturn.reduce((a, b) => new Date(a.planned_return) < new Date(b.planned_return) ? a : b);
        }
        document.getElementById('reminderNextDue').innerText = next ? `Next due: ${formatDateShort(next.planned_return)}` : 'Next due: --';
    }

    async function loadPendingRequests() {
        try {
            const res = await authenticatedFetch('/api/admin/requests/pending');
            const data = await res.json();
            updateNumber('pendingCount', data.length);
            updateNumber('pendingKeyRequestsCount', data.length);
            window._pendingRequestsData = data;
        } catch (err) {
            updateNumber('pendingCount', 0);
            updateNumber('pendingKeyRequestsCount', 0);
            showAlertModal(err.message || 'Unable to load pending requests. Please refresh.', 'error');
        }
    }

    function showPendingRequestsModal() {
        const data = window._pendingRequestsData || [];
        if (!data.length) {
            showDetailModal('Pending Requests', '<div class="text-center py-8 text-slate-400">No pending requests.</div>');
            return;
        }
        let rows = '';
        for (const req of data) {
            const keyList = req.key_details?.map(k => `${k.code} x${k.quantity}`).join(', ') || '—';
            rows += `<tr>
                <td>${escapeHtml(req.requester_name)}</td>
                <td>${escapeHtml(req.requester_email)}</td>
                <td>${escapeHtml(keyList)}</td>
                <td>${formatDate(req.planned_return)}</td>
                <td>
                    <div class="action-buttons">
                        <button class="btn btn-success approveBtnModal" data-id="${req.id}"><i class="fas fa-check"></i> Approve</button>
                        <button class="btn btn-danger denyBtnModal" data-id="${req.id}"><i class="fas fa-times"></i> Deny</button>
                    </div>
                </td>
            </tr>`;
        }
        const html = `<table class="table-clean"><thead><tr><th>Requester</th><th>Email</th><th>Keys</th><th>Planned Return</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`;
        showDetailModal('Pending Requests', html);
        document.querySelectorAll('.approveBtnModal, .denyBtnModal').forEach(btn => {
            btn.addEventListener('click', function() {
                const action = this.classList.contains('approveBtnModal') ? 'approve' : 'deny';
                currentAction = action;
                currentRequestId = parseInt(this.dataset.id);
                document.getElementById('modalTitle').textContent = action === 'approve' ? 'Approve request' : 'Deny request';
                document.getElementById('modalNotes').value = '';
                document.getElementById('adminModal').style.display = 'flex';
                closeDetailModal();
            });
        });
    }

    async function loadPendingReturns() {
        try {
            const res = await authenticatedFetch('/api/return/pending');
            const data = await res.json();
            updateNumber('pendingReturnsCount', data.length);
            window._pendingReturnsData = data;
        } catch (err) {
            updateNumber('pendingReturnsCount', 0);
            showAlertModal(err.message || 'Unable to load pending returns. Please refresh.', 'error');
        }
    }

    function showPendingReturnsModal() {
        const data = window._pendingReturnsData || [];
        if (!data.length) {
            showDetailModal('Pending Returns', '<div class="text-center py-8 text-slate-400">No pending returns.</div>');
            return;
        }
        let rows = '';
        for (const ret of data) {
            rows += `<tr>
                <td>${escapeHtml(ret.requester_name || ret.requester_email)}</td>
                <td>${escapeHtml(ret.key_list)}</td>
                <td>${formatDate(ret.created_at)}</td>
                <td>
                    <div class="action-buttons">
                        <button class="btn btn-success approveReturnModalBtn" data-id="${ret.id}"><i class="fas fa-check"></i> Verify</button>
                    </div>
                </td>
            </tr>`;
        }
        const html = `<table class="table-clean"><thead><tr><th>Requester</th><th>Keys</th><th>Requested</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table>`;
        showDetailModal('Pending Returns', html);
        document.querySelectorAll('.approveReturnModalBtn').forEach(btn => {
            btn.addEventListener('click', async function() {
                const id = parseInt(this.dataset.id);
                try {
                    const res = await authenticatedFetch('/api/return/verify', {
                        method: 'POST',
                        body: JSON.stringify({ return_request_id: id })
                    });
                    if (res.ok) {
                        showAlertModal('Return verified successfully.', 'success');
                        closeDetailModal();
                        loadPendingReturns();
                        loadTransactions();
                    } else {
                        const data = await res.json();
                        showAlertModal(data.error || 'Verification failed. Please try again.', 'error');
                    }
                } catch (err) {
                    showAlertModal(err.message || 'Network error. Please check your connection.', 'error');
                }
            });
        });
    }

    async function loadLostKeys() {
        try {
            const res = await authenticatedFetch('/api/admin/lost-keys');
            const data = await res.json();
            updateNumber('lostKeysCount', data.length);
            window._lostKeysData = data;
        } catch (err) {
            updateNumber('lostKeysCount', 0);
            showAlertModal(err.message || 'Unable to load lost keys. Please refresh the page.', 'error');
        }
    }

    function showLostKeysModal() {
        const data = window._lostKeysData || [];
        if (!data.length) {
            showDetailModal('Lost Keys', '<div class="text-center py-8 text-slate-400">No lost keys.</div>');
            return;
        }
        let rows = '';
        for (const item of data) {
            const statusLabel = item.resolved_at ? 'Resolved' : 'Lost';
            const statusClass = item.resolved_at ? 'returned' : 'lost';
            rows += `<tr class="lost-key-row" data-tx-id="${item.id}">
                <td><code>${escapeHtml(item.key_code)}</code></td>
                <td>${escapeHtml(item.brand)}</td>
                <td>${escapeHtml(item.borrower_name || item.borrower_email)}</td>
                <td>${formatDate(item.lost_at)}</td>
                <td><span class="status-badge ${statusClass}">${statusLabel}</span></td>
                <td>
                    <div class="actions-dropdown">
                        <button class="dropdown-toggle" data-tx-id="${item.id}">
                            Actions <i class="fas fa-chevron-down"></i>
                        </button>
                        <div class="dropdown-menu" data-tx-id="${item.id}">
                            <button class="dropdown-item btn-view" data-tx-id="${item.id}" title="View Details">
                                <i class="fas fa-eye"></i> View
                            </button>
                            <button class="dropdown-item btn-edit" data-tx-id="${item.id}" title="Edit">
                                <i class="fas fa-edit"></i> Edit
                            </button>
                            ${!item.fine_id && !item.resolved_at ? `
                                <button class="dropdown-item btn-primary" data-tx-id="${item.id}" data-action="create-fine" title="Create Fee">
                                    <i class="fas fa-plus-circle"></i> Create Fee
                                </button>
                            ` : ''}
                            ${!item.resolved_at ? `
                                <button class="dropdown-item btn-success" data-tx-id="${item.id}" data-action="close-ticket" title="Close Ticket">
                                    <i class="fas fa-check-circle"></i> Close Ticket
                                </button>
                            ` : ''}
                            <button class="dropdown-item btn-warning" data-tx-id="${item.id}" data-action="make-available" title="Make Available">
                                <i class="fas fa-check"></i> Make Available
                            </button>
                            ${item.fine_id && item.fine_status === 'pending' ? `
                                <div class="dropdown-divider"></div>
                                <button class="dropdown-item btn-success" data-tx-id="${item.id}" data-action="mark-paid" data-fine-id="${item.fine_id}" title="Mark Paid">
                                    <i class="fas fa-dollar-sign"></i> Mark Paid
                                </button>
                                <button class="dropdown-item btn-warning" data-tx-id="${item.id}" data-action="waive" data-fine-id="${item.fine_id}" title="Waive">
                                    <i class="fas fa-handshake"></i> Waive Fee
                                </button>
                            ` : ''}
                        </div>
                    </div>
                </td>
            </tr>`;
        }
        const html = `<table class="table-clean"><thead><tr><th>Key</th><th>Brand</th><th>Borrower</th><th>Lost Date</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`;
        showDetailModal('Lost Keys', html);
        
        document.querySelectorAll('#detailModalContent .actions-dropdown').forEach(dropdown => {
            const toggle = dropdown.querySelector('.dropdown-toggle');
            const menu = dropdown.querySelector('.dropdown-menu');
            
            toggle.addEventListener('click', function(e) {
                e.stopPropagation();
                document.querySelectorAll('#detailModalContent .dropdown-menu').forEach(m => {
                    if (m !== menu) m.classList.remove('show');
                });
                menu.classList.toggle('show');
            });
            
            menu.querySelectorAll('.dropdown-item').forEach(item => {
                item.addEventListener('click', function(e) {
                    e.stopPropagation();
                    const txId = parseInt(this.dataset.txId);
                    const action = this.dataset.action || 'view';
                    const lostItem = window._lostKeysData?.find(d => d.id === txId);
                    if (lostItem) {
                        menu.classList.remove('show');
                        executeLostKeyAction(action, lostItem);
                    }
                });
            });
        });
        
        document.addEventListener('click', function(e) {
            if (!e.target.closest('.actions-dropdown')) {
                document.querySelectorAll('#detailModalContent .dropdown-menu').forEach(m => m.classList.remove('show'));
            }
        });
    }

    function executeLostKeyAction(action, item) {
        const keyCode = item.key_code || 'unknown';
        switch (action) {
            case 'view':
                showLostKeyDetailFromItem(item);
                break;
            case 'edit':
                openLostKeyEditModal(item.id);
                break;
            case 'create-fine':
                if (!confirm(`Create a $50 fee for lost key ${keyCode}?`)) return;
                (async () => {
                    try {
                        const res = await authenticatedFetch(`/api/admin/lost-keys/${item.id}/create-fine`, { method: 'POST' });
                        const data = await res.json();
                        if (res.ok) {
                            await logAuditEvent('create_fine', 'lost_key', item.id, {
                                key_code: keyCode,
                                amount: 50,
                                borrower: item.borrower_name || item.borrower_email
                            });
                            showAlertModal('Fee created successfully.', 'success');
                            closeDetailModal();
                            await loadLostKeys();
                            await loadTransactions();
                            await loadLostKeysManagement();
                        } else {
                            showAlertModal(data.error || 'Failed to create fee. Please try again.', 'error');
                        }
                    } catch (err) {
                        showAlertModal(err.message || 'Network error. Please check your connection.', 'error');
                    }
                })();
                break;
            case 'mark-paid':
                if (!confirm(`Mark fee for ${keyCode} as paid?`)) return;
                (async () => {
                    try {
                        const res = await authenticatedFetch(`/api/admin/fines/${item.fine_id}/paid`, { method: 'POST' });
                        if (res.ok) {
                            await logAuditEvent('mark_fine_paid', 'lost_key', item.id, {
                                key_code: keyCode,
                                fine_id: item.fine_id
                            });
                            showAlertModal('Fee marked paid.', 'success');
                            closeDetailModal();
                            await loadLostKeys();
                            await loadTransactions();
                            await loadLostKeysManagement();
                        } else {
                            const data = await res.json();
                            showAlertModal(data.error || 'Action failed. Please try again.', 'error');
                        }
                    } catch (err) {
                        showAlertModal(err.message || 'Network error. Please check your connection.', 'error');
                    }
                })();
                break;
            case 'waive':
                if (!confirm(`Waive fee for ${keyCode}?`)) return;
                (async () => {
                    try {
                        const res = await authenticatedFetch(`/api/admin/fines/${item.fine_id}/waived`, { method: 'POST' });
                        if (res.ok) {
                            await logAuditEvent('waive_fine', 'lost_key', item.id, {
                                key_code: keyCode,
                                fine_id: item.fine_id
                            });
                            showAlertModal('Fee waived.', 'success');
                            closeDetailModal();
                            await loadLostKeys();
                            await loadTransactions();
                            await loadLostKeysManagement();
                        } else {
                            const data = await res.json();
                            showAlertModal(data.error || 'Action failed. Please try again.', 'error');
                        }
                    } catch (err) {
                        showAlertModal(err.message || 'Network error. Please check your connection.', 'error');
                    }
                })();
                break;
            case 'close-ticket':
                if (!confirm(`Close lost ticket for key ${keyCode}? This will mark the issue as resolved.`)) return;
                const notes = prompt('Resolution notes (optional):');
                (async () => {
                    try {
                        const res = await authenticatedFetch(`/api/admin/lost-keys/${item.id}/close`, {
                            method: 'POST',
                            body: JSON.stringify({ resolution_notes: notes || null })
                        });
                        if (res.ok) {
                            await logAuditEvent('close_lost_ticket', 'lost_key', item.id, {
                                key_code: keyCode,
                                resolution_notes: notes || null
                            });
                            showAlertModal('Ticket closed successfully.', 'success');
                            closeDetailModal();
                            await loadLostKeys();
                            await loadTransactions();
                            await loadInventory();
                            await loadLostKeysManagement();
                        } else {
                            const data = await res.json();
                            showAlertModal(data.error || 'Failed to close ticket. Please try again.', 'error');
                        }
                    } catch (err) {
                        showAlertModal(err.message || 'Network error. Please check your connection.', 'error');
                    }
                })();
                break;
            case 'make-available':
                if (!confirm(`Mark key ${keyCode} as available again? This will make it available for borrowing.`)) return;
                (async () => {
                    try {
                        const res = await authenticatedFetch(`/api/admin/lost-keys/${item.id}/make-available`, {
                            method: 'POST'
                        });
                        if (res.ok) {
                            await logAuditEvent('make_key_available', 'lost_key', item.id, {
                                key_code: keyCode
                            });
                            showAlertModal(`Key ${keyCode} is now available.`, 'success');
                            closeDetailModal();
                            await loadLostKeys();
                            await loadTransactions();
                            await loadInventory();
                            await loadLostKeysManagement();
                        } else {
                            const data = await res.json();
                            showAlertModal(data.error || 'Failed to make key available. Please try again.', 'error');
                        }
                    } catch (err) {
                        showAlertModal(err.message || 'Network error. Please check your connection.', 'error');
                    }
                })();
                break;
        }
    }

    async function showLostKeyDetailFromItem(item) {
        const modal = document.getElementById('lostKeyDetailModal');
        const content = document.getElementById('lostKeyDetailContent');
        modal.style.display = 'flex';
        content.innerHTML = '<div class="text-center py-8 text-slate-400">Loading details...</div>';
        try {
            const res = await authenticatedFetch(`/api/admin/lost-keys/${item.id}`);
            const data = await res.json();
            const formatAmount = (amount) => {
                const num = safeNumber(amount);
                return num.toFixed(2);
            };
            const statusClass = data.resolved_at ? 'returned' : 'lost';
            const statusLabel = data.resolved_at ? 'Resolved' : 'Lost';
            const html = `
                <div class="detail-section"><div class="detail-label">Key Information</div>
                    <div class="detail-grid">
                        <div><span class="detail-label">Code</span><div class="detail-value">${escapeHtml(data.key_code)}</div></div>
                        <div><span class="detail-label">Brand</span><div class="detail-value">${escapeHtml(data.brand || '—')}</div></div>
                        <div><span class="detail-label">Status</span><div class="detail-value"><span class="status-badge ${statusClass}">${statusLabel}</span></div></div>
                    </div>
                </div>
                <div class="detail-section"><div class="detail-label">Borrower</div>
                    <div class="detail-grid">
                        <div><span class="detail-label">Name</span><div class="detail-value">${escapeHtml(data.borrower_name || '—')}</div></div>
                        <div><span class="detail-label">Email</span><div class="detail-value">${escapeHtml(data.borrower_email || '—')}</div></div>
                    </div>
                </div>
                <div class="detail-section"><div class="detail-label">Lost Event</div>
                    <div class="detail-grid">
                        <div><span class="detail-label">Lost At</span><div class="detail-value">${formatDate(data.lost_at)}</div></div>
                        <div><span class="detail-label">Planned Return</span><div class="detail-value">${formatDate(data.planned_return)}</div></div>
                        ${data.returned_at ? `<div><span class="detail-label">Returned At</span><div class="detail-value">${formatDate(data.returned_at)}</div></div>` : ''}
                        <div class="full-width"><span class="detail-label">Reason</span><div class="detail-value">${escapeHtml(data.reason || '—')}</div></div>
                        ${data.resolved_at ? `<div><span class="detail-label">Resolved At</span><div class="detail-value">${formatDate(data.resolved_at)}</div></div>` : ''}
                    </div>
                </div>
                ${data.fine ? `
                <div class="detail-section"><div class="detail-label">Fee</div>
                    <div class="detail-grid">
                        <div><span class="detail-label">Amount</span><div class="detail-value">$${formatAmount(data.fine.amount)}</div></div>
                        <div><span class="detail-label">Status</span><div class="detail-value"><span class="status-badge ${data.fine.status === 'paid' ? 'returned' : 'pending'}">${escapeHtml(data.fine.status || 'pending')}</span></div></div>
                        <div><span class="detail-label">Issued</span><div class="detail-value">${formatDate(data.fine.created_at)}</div></div>
                        ${data.fine.paid_at ? `<div><span class="detail-label">Paid At</span><div class="detail-value">${formatDate(data.fine.paid_at)}</div></div>` : ''}
                        ${data.fine.waived_at ? `<div><span class="detail-label">Waived At</span><div class="detail-value">${formatDate(data.fine.waived_at)}</div></div>` : ''}
                    </div>
                </div>` : ''}
            `;
            content.innerHTML = html;
        } catch (err) {
            content.innerHTML = `<div class="text-center py-8 text-rose-600">Unable to load details: ${escapeHtml(err.message || 'Please refresh and try again.')}</div>`;
            showAlertModal(err.message || 'Failed to load lost key details. Please check your connection.', 'error');
        }
    }

    function showActiveBorrowsModal() {
        const data = window._activeBorrowsData || [];
        if (!data.length) {
            showDetailModal('Active Borrows', '<div class="text-center py-8 text-slate-400">No active borrows.</div>');
            return;
        }
        let rows = '';
        for (const tx of data) {
            const now = new Date();
            now.setHours(0, 0, 0, 0);
            const due = new Date(tx.planned_return);
            due.setHours(0, 0, 0, 0);
            let statusTag = due < now ? 'Overdue' : due.toDateString() === now.toDateString() ? 'Due today' : 'On loan';
            const statusClass = due < now ? 'overdue' : due.toDateString() === now.toDateString() ? 'pending' : 'borrowed';
            rows += `<tr>
                <td>${escapeHtml(tx.key_code)}</td>
                <td>${escapeHtml(tx.receiver_signature_name || tx.receiver_email)}</td>
                <td>${formatDate(tx.borrowed_at)}</td>
                <td>${formatDate(tx.planned_return)}</td>
                <td><span class="status-badge ${statusClass}">${statusTag}</span></td>
            </tr>`;
        }
        const html = `<table class="table-clean"><thead><tr><th>Key</th><th>Borrower</th><th>Borrowed</th><th>Expected Return</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`;
        showDetailModal('Active Borrows', html);
    }

    function showReturnRemindersModal() {
        const data = window._activeBorrowsData || [];
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const overdue = [], upcoming = [];
        for (const tx of data) {
            if (!tx.planned_return) continue;
            const d = new Date(tx.planned_return);
            d.setHours(0, 0, 0, 0);
            if (d < today) overdue.push(tx);
            else if (d <= new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000)) upcoming.push(tx);
        }
        overdue.sort((a, b) => new Date(a.planned_return) - new Date(b.planned_return));
        upcoming.sort((a, b) => new Date(a.planned_return) - new Date(b.planned_return));
        const combined = [...overdue, ...upcoming];
        if (!combined.length) {
            showDetailModal('Return Reminders', '<div class="text-center py-8 text-slate-400">No upcoming or overdue returns.</div>');
            return;
        }
        let rows = '', overdueCount = 0;
        for (const tx of combined) {
            const due = new Date(tx.planned_return);
            const days = Math.ceil((due - today) / (1000 * 60 * 60 * 24));
            let statusLabel, statusClass;
            if (days < 0) {
                statusLabel = `Overdue by ${Math.abs(days)} day${Math.abs(days) !== 1 ? 's' : ''}`;
                statusClass = 'overdue';
                overdueCount++;
            } else if (days === 0) {
                statusLabel = 'Due today';
                statusClass = 'pending';
            } else {
                statusLabel = `${days} day${days !== 1 ? 's' : ''} left`;
                statusClass = 'borrowed';
            }
            rows += `<tr class="${days < 0 ? 'bg-rose-50' : ''}">
                <td>${escapeHtml(tx.key_code)}</td>
                <td>${escapeHtml(tx.receiver_signature_name || tx.receiver_email)}</td>
                <td>${formatDate(tx.planned_return)}</td>
                <td><span class="status-badge ${statusClass}">${statusLabel}</span></td>
            </tr>`;
        }
        const summary = overdueCount > 0 ? `<div class="mb-3 p-2 bg-rose-100 text-rose-800 rounded-lg text-sm font-medium">⚠️ ${overdueCount} overdue return${overdueCount > 1 ? 's' : ''} — please take action.</div>` : '';
        const html = summary + `<table class="table-clean"><thead><tr><th>Key</th><th>Borrower</th><th>Due Date</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`;
        showDetailModal('Return Reminders', html);
    }

    async function loadAuditHealth() {
        try {
            const res = await authenticatedFetch('/api/admin/audit-health');
            const data = await res.json();
            const text = document.getElementById('auditStatusText');
            const last = document.getElementById('auditLastCheck');
            if (data.status === 'ok') {
                text.innerHTML = '✅ Chain intact';
                text.className = 'text-sm font-medium text-emerald-600';
            } else if (data.status === 'tampered') {
                text.innerHTML = '⚠️ TAMPER DETECTED';
                text.className = 'text-sm font-medium text-rose-600';
            } else if (data.status === 'error') {
                text.innerHTML = '⚠️ Validation error';
                text.className = 'text-sm font-medium text-amber-600';
            } else {
                text.innerHTML = 'Unknown';
                text.className = 'text-sm font-medium text-slate-500';
            }
            last.innerText = data.checked_at ? `Last check: ${formatDate(data.checked_at)}` : 'Last check: --';
        } catch (err) {
            document.getElementById('auditStatusText').innerHTML = '❌ Unable to verify audit integrity. Please refresh.';
            showAlertModal(err.message || 'Failed to load audit health status. Please check your network.', 'error');
        }
    }

    async function loadInventory() {
        const container = document.getElementById('inventoryTableBody');
        container.innerHTML = '<tr><td colspan="5" class="text-center py-8 text-slate-400"><div class="skeleton h-8 w-full"></div></td></tr>';
        try {
            const res = await authenticatedFetch('/api/admin/keys');
            const data = await res.json();
            inventoryData = Array.isArray(data) ? data : [];
            applyInventoryFilters();
        } catch (err) {
            container.innerHTML = '<tr><td colspan="5" class="text-center py-8 text-rose-600">Unable to load keys. Please refresh the page.</td></tr>';
            showAlertModal(err.message || 'Failed to load inventory. Please check your network.', 'error');
        }
    }

    function applyInventoryFilters() {
        const search = safeLower(document.getElementById('inventorySearchInput').value).trim();
        filteredInventory = inventoryData.filter(key => {
            const matchesSearch = safeLower(key.code).includes(search) ||
                safeLower(key.brand).includes(search) ||
                safeLower(key.sets).includes(search) ||
                safeLower(key.remarks).includes(search);
            return matchesSearch;
        });
        invTotal = filteredInventory.length;
        renderInventoryTable();
        updateInventoryPagination();
    }

    function renderInventoryTable() {
        const tbody = document.getElementById('inventoryTableBody');
        const start = (invPage - 1) * invRows;
        const end = Math.min(start + invRows, invTotal);
        const pageData = filteredInventory.slice(start, end);
        if (!pageData.length) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center py-8 text-slate-400">No keys found.</td></tr>';
            return;
        }
        let html = '';
        for (const key of pageData) {
            let setsDisplay = '—';
            if (key.sets && Array.isArray(key.sets) && key.sets.length) {
                setsDisplay = key.sets.map(s => `${escapeHtml(s.owner_name || 'Unknown')} (${s.quantity || 1})`).join(', ');
            }
            html += `
                <tr class="inventory-row clickable" data-key-id="${key.id}" style="cursor:pointer;">
                    <td><code>${escapeHtml(key.code)}</code></td>
                    <td>${escapeHtml(key.brand)}</td>
                    <td>${escapeHtml(setsDisplay)}</td>
                    <td>${escapeHtml(key.total_quantity || 0)}</td>
                    <td>${escapeHtml(key.remarks || '—')}</td>
                </tr>
            `;
        }
        tbody.innerHTML = html;
        tbody.querySelectorAll('.inventory-row').forEach(row => {
            row.addEventListener('click', function() {
                const id = parseInt(this.dataset.keyId);
                showKeyDetailModal(id);
            });
        });
    }

    function updateInventoryPagination() {
        const totalPages = Math.ceil(invTotal / invRows) || 1;
        const start = (invPage - 1) * invRows + 1;
        const end = Math.min(invPage * invRows, invTotal);
        document.getElementById('inventoryPaginationInfo').innerText = invTotal === 0 ? 'Showing 0 of 0 keys' : `Showing ${start}–${end} of ${invTotal} keys`;
        document.getElementById('inventoryPrevPageBtn').disabled = invPage === 1 || invTotal === 0;
        document.getElementById('inventoryNextPageBtn').disabled = invPage >= totalPages || invTotal === 0;
    }

    async function showKeyDetailModal(keyId) {
        const modal = document.getElementById('keyDetailModal');
        const content = document.getElementById('keyDetailModalContent');
        modal.style.display = 'flex';
        content.innerHTML = '<div class="text-center py-8 text-slate-400">Loading key details...</div>';
        try {
            const [keyRes, auditRes] = await Promise.all([
                authenticatedFetch(`/api/admin/keys/${keyId}`),
                authenticatedFetch(`/api/audit/logs?target_type=key&target_id=${keyId}`)
            ]);
            const key = await keyRes.json();
            const auditLogs = await auditRes.json();

            let setsDisplay = '—';
            if (key.sets && Array.isArray(key.sets) && key.sets.length) {
                setsDisplay = key.sets.map(s => `${escapeHtml(s.owner_name)} (${s.quantity})`).join(', ');
            }

            let auditHtml = '<div class="detail-section"><div class="detail-label">Audit Trail</div>';
            if (auditLogs && auditLogs.length) {
                auditHtml += `<table class="table-clean"><thead><tr><th>Action</th><th>User</th><th>Timestamp</th></tr></thead><tbody>`;
                for (const log of auditLogs.slice(0, 10)) {
                    auditHtml += `<tr>
                        <td>${escapeHtml(log.action)}</td>
                        <td>${escapeHtml(log.user_name || log.user_email || 'System')}</td>
                        <td>${formatDate(log.created_at)}</td>
                    </tr>`;
                }
                auditHtml += `</tbody></table>`;
                if (auditLogs.length > 10) {
                    auditHtml += `<p class="text-xs text-slate-500 mt-2">Showing last 10 of ${auditLogs.length} entries</p>`;
                }
            } else {
                auditHtml += `<p class="text-sm text-slate-500">No audit logs found for this key.</p>`;
            }
            auditHtml += '</div>';

            const html = `
                <div class="detail-section">
                    <div class="detail-label">Key Information</div>
                    <div class="detail-grid">
                        <div><span class="detail-label">Code</span><div class="detail-value">${escapeHtml(key.code)}</div></div>
                        <div><span class="detail-label">Brand</span><div class="detail-value">${escapeHtml(key.brand)}</div></div>
                        <div><span class="detail-label">Owner(s)</span><div class="detail-value">${escapeHtml(setsDisplay)}</div></div>
                        <div><span class="detail-label">Total Quantity</span><div class="detail-value">${escapeHtml(key.total_quantity || 0)}</div></div>
                        <div class="full-width"><span class="detail-label">Remarks</span><div class="detail-value">${escapeHtml(key.remarks || '—')}</div></div>
                    </div>
                </div>
                <div class="detail-section">
                    <div class="detail-label">Key Metadata</div>
                    <div class="detail-grid">
                        <div><span class="detail-label">Created At</span><div class="detail-value">${formatDate(key.created_at)}</div></div>
                        <div><span class="detail-label">Last Updated</span><div class="detail-value">${formatDate(key.updated_at)}</div></div>
                        <div><span class="detail-label">Updated By</span><div class="detail-value">${escapeHtml(key.updated_by || '—')}</div></div>
                    </div>
                </div>
                ${auditHtml}
            `;
            content.innerHTML = html;
            document.getElementById('keyDetailModalTitle').textContent = `Key: ${key.code}`;
        } catch (err) {
            content.innerHTML = `<div class="text-center py-8 text-rose-600">Unable to load key details: ${escapeHtml(err.message || 'Please refresh and try again.')}</div>`;
            showAlertModal(err.message || 'Failed to load key details. Please check your connection.', 'error');
        }
    }

    async function openKeyManageModal() {
        const modal = document.getElementById('keyManageModal');
        modal.style.display = 'flex';
        await fetchManageKeys();
    }

    async function fetchManageKeys() {
        const tbody = document.getElementById('manageKeyTableBody');
        tbody.innerHTML = '<tr><td colspan="4" class="text-center py-8 text-slate-400">Loading keys...</td></tr>';
        const search = safeLower(document.getElementById('manageKeySearch')?.value || '').trim();
        try {
            const res = await authenticatedFetch('/api/admin/keys');
            const data = await res.json();
            manageKeyData = Array.isArray(data) ? data : [];
            manageKeyFiltered = manageKeyData.filter(key => {
                const matchSearch = safeLower(key.code).includes(search) ||
                    safeLower(key.brand).includes(search) ||
                    safeLower(key.sets).includes(search);
                return matchSearch;
            });
            manageKeyTotal = manageKeyFiltered.length;
            renderManageKeyTable();
            updateManageKeyPagination();
        } catch (err) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-center py-8 text-rose-600">Unable to load keys.</td></tr>';
            showAlertModal(err.message || 'Failed to load keys for management.', 'error');
        }
    }

    function renderManageKeyTable() {
        const tbody = document.getElementById('manageKeyTableBody');
        const start = (manageKeyPage - 1) * manageKeyRows;
        const end = Math.min(start + manageKeyRows, manageKeyTotal);
        const pageData = manageKeyFiltered.slice(start, end);
        if (!pageData.length) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-center py-8 text-slate-400">No keys found.</td></tr>';
            return;
        }
        let html = '';
        for (const key of pageData) {
            let setsDisplay = '—';
            if (key.sets && Array.isArray(key.sets) && key.sets.length) {
                setsDisplay = key.sets.map(s => `${escapeHtml(s.owner_name)} (${s.quantity})`).join(', ');
            }
            html += `
                <tr>
                    <td class="text-left"><code>${escapeHtml(key.code)}</code></td>
                    <td class="text-left">${escapeHtml(key.brand)}</td>
                    <td class="text-left">${escapeHtml(setsDisplay)}</td>
                    <td class="text-right">
                        <div class="action-buttons" style="justify-content:flex-end;">
                            <button class="btn btn-secondary btn-sm edit-manage-key-btn" data-id="${key.id}">
                                <i class="fas fa-edit"></i> Edit
                            </button>
                            <button class="btn btn-danger btn-sm delete-manage-key-btn" data-id="${key.id}" data-code="${escapeHtml(key.code)}">
                                <i class="fas fa-trash"></i> Delete
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        }
        tbody.innerHTML = html;
        tbody.querySelectorAll('.edit-manage-key-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                const id = parseInt(this.dataset.id);
                const key = manageKeyData.find(k => k.id === id);
                if (key) {
                    openKeyEditModal(key);
                    document.getElementById('keyManageModal').style.display = 'none';
                }
            });
        });
        tbody.querySelectorAll('.delete-manage-key-btn').forEach(btn => {
            btn.addEventListener('click', async function() {
                const id = this.dataset.id;
                const code = this.dataset.code;
                if (!confirm(`Delete key ${code}? This action cannot be undone.`)) return;
                try {
                    const res = await authenticatedFetch(`/api/admin/keys/${id}`, { method: 'DELETE' });
                    if (res.ok) {
                        await logAuditEvent('delete_key', 'key', id, {
                            key_code: code
                        });
                        showAlertModal('Key deleted successfully.', 'success');
                        fetchManageKeys();
                        loadInventory();
                    } else {
                        const data = await res.json();
                        showAlertModal(data.error || 'Deletion failed. Please try again.', 'error');
                    }
                } catch (err) {
                    showAlertModal(err.message || 'Network error. Please check your connection.', 'error');
                }
            });
        });
    }

    function updateManageKeyPagination() {
        const totalPages = Math.ceil(manageKeyTotal / manageKeyRows) || 1;
        const start = (manageKeyPage - 1) * manageKeyRows + 1;
        const end = Math.min(manageKeyPage * manageKeyRows, manageKeyTotal);
        document.getElementById('manageKeyPaginationInfo').innerText = manageKeyTotal === 0 ? 'Showing 0 of 0 keys' : `Showing ${start}–${end} of ${manageKeyTotal} keys`;
        document.getElementById('manageKeyPrevBtn').disabled = manageKeyPage === 1 || manageKeyTotal === 0;
        document.getElementById('manageKeyNextBtn').disabled = manageKeyPage >= totalPages || manageKeyTotal === 0;
    }

    function openKeyEditModal(key = null) {
        const modal = document.getElementById('keyEditModal');
        const title = document.getElementById('keyEditModalTitle');
        const idField = document.getElementById('editKeyId');
        const codeField = document.getElementById('editKeyCode');
        const brandField = document.getElementById('editKeyBrand');
        const ownerField = document.getElementById('editKeyOwner');
        const setsField = document.getElementById('editKeySets');
        const dateOwnedField = document.getElementById('editKeyDateOwned');
        const remarksField = document.getElementById('editKeyRemarks');
        const lostField = document.getElementById('editKeyLost');

        if (key) {
            title.textContent = 'Edit Key';
            idField.value = key.id;
            codeField.value = key.code;
            brandField.value = key.brand;
            if (key.sets && Array.isArray(key.sets) && key.sets.length) {
                ownerField.value = key.sets.map(s => s.owner_name).join(', ');
                setsField.value = key.sets.reduce((sum, s) => sum + (s.quantity || 0), 0);
            } else {
                ownerField.value = '';
                setsField.value = '';
            }
            dateOwnedField.value = key.date_owned || '';
            remarksField.value = key.remarks || '';
            lostField.checked = key.is_lost || false;
        } else {
            title.textContent = 'Add New Key';
            idField.value = '';
            codeField.value = '';
            brandField.value = '';
            ownerField.value = '';
            setsField.value = '';
            dateOwnedField.value = '';
            remarksField.value = '';
            lostField.checked = false;
        }
        modal.style.display = 'flex';
    }

    async function checkEmailPermissions() {
        try {
            const res = await authenticatedFetch('/api/user/permissions');
            const data = await res.json();
            const permsArray = toArray(data);
            const canManageTemplates = permsArray.includes('manage_email_templates');
            const canManageSettings = permsArray.includes('manage_notification_settings');
            const canManageEmail = canManageTemplates && canManageSettings;
            const emailTab = document.querySelector('.tab-button[data-tab="email"]');
            if (emailTab) emailTab.style.display = canManageEmail ? '' : 'none';
            return canManageEmail;
        } catch (err) {
            const emailTab = document.querySelector('.tab-button[data-tab="email"]');
            if (emailTab) emailTab.style.display = 'none';
            showAlertModal(err.message || 'Unable to load permissions. Please refresh.', 'error');
            return false;
        }
    }

    async function loadEmailTab() {
        if (emailTabLoaded) return;
        const canManage = await checkEmailPermissions();
        if (!canManage) return;
        emailTabLoaded = true;
        await Promise.all([loadTemplates(), loadSettings()]);
        loadAdminRecipients();
    }

    async function loadTemplates() {
        const container = document.getElementById('templatesContainer');
        container.innerHTML = '<div class="text-center py-8 text-slate-400">Loading templates...</div>';
        try {
            const res = await authenticatedFetch('/api/admin/email/templates');
            const templates = await res.json();
            if (!templates.length) {
                container.innerHTML = '<div class="text-center py-8 text-slate-400">No templates found.</div>';
                return;
            }
            let html = `<table class="table-clean template-list"><thead><tr><th class="text-left">Key</th><th class="text-left">Subject</th><th>Active</th></tr></thead><tbody>`;
            for (const t of templates) {
                html += `<tr class="template-row clickable" data-key="${escapeHtml(t.template_key)}">
                    <td class="text-left"><code>${escapeHtml(t.template_key)}</code></td>
                    <td class="text-left">${escapeHtml(t.subject)}</td>
                    <td>${t.is_active ? '✅' : '❌'}</td>
                </tr>`;
            }
            html += `</tbody></table>`;
            container.innerHTML = html;
            container.querySelectorAll('.template-row.clickable').forEach(row => {
                row.addEventListener('click', function() {
                    const key = this.dataset.key;
                    openTemplateEditModal(key);
                });
                row.style.cursor = 'pointer';
            });
        } catch (err) {
            container.innerHTML = '<div class="text-center py-8 text-rose-600">Failed to load templates. Please refresh.</div>';
            showAlertModal(err.message || 'Unable to load email templates. Please check your network.', 'error');
        }
    }

    async function openTemplateManageModal() {
        const modal = document.getElementById('templateManageModal');
        const container = document.getElementById('templateManageContainer');
        modal.style.display = 'flex';
        container.innerHTML = '<div class="text-center py-8 text-slate-400">Loading templates...</div>';
        try {
            const res = await authenticatedFetch('/api/admin/email/templates');
            const templates = await res.json();
            if (!templates.length) {
                container.innerHTML = '<div class="text-center py-8 text-slate-400">No templates found.</div>';
                return;
            }
            let html = `<table class="table-clean template-manage-table"><thead><tr><th class="text-left">Key</th><th class="text-left">Subject</th><th>Active</th><th class="text-right">Actions</th></tr></thead><tbody>`;
            for (const t of templates) {
                html += `<tr>
                    <td class="text-left"><code>${escapeHtml(t.template_key)}</code></td>
                    <td class="text-left">${escapeHtml(t.subject)}</td>
                    <td>${t.is_active ? '✅' : '❌'}</td>
                    <td class="text-right">
                        <div class="action-buttons" style="justify-content:flex-end;">
                            <button class="btn btn-secondary btn-sm edit" data-key="${escapeHtml(t.template_key)}" title="Edit"><i class="fas fa-edit"></i> Edit</button>
                            <button class="btn btn-danger btn-sm delete" data-key="${escapeHtml(t.template_key)}" title="Delete"><i class="fas fa-trash"></i> Delete</button>
                        </div>
                    </td>
                </tr>`;
            }
            html += `</tbody></table>`;
            container.innerHTML = html;

            container.querySelectorAll('.edit').forEach(btn => {
                btn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    openTemplateEditModal(this.dataset.key);
                });
            });
            container.querySelectorAll('.delete').forEach(btn => {
                btn.addEventListener('click', async function(e) {
                    e.stopPropagation();
                    const key = this.dataset.key;
                    if (!confirm(`Delete template "${key}"?`)) return;
                    try {
                        const res = await authenticatedFetch(`/api/admin/email/templates/${key}`, { method: 'DELETE' });
                        if (res.ok) {
                            await logAuditEvent('delete_email_template', 'email_template', key, {
                                template_key: key
                            });
                            showAlertModal('Template deleted successfully.', 'success');
                            openTemplateManageModal();
                            loadTemplates();
                        } else {
                            const data = await res.json();
                            showAlertModal(data.error || 'Delete failed. Please try again.', 'error');
                        }
                    } catch (err) {
                        showAlertModal(err.message || 'Network error. Please check your connection.', 'error');
                    }
                });
            });
        } catch (err) {
            container.innerHTML = '<div class="text-center py-8 text-rose-600">Failed to load templates. Please refresh.</div>';
            showAlertModal(err.message || 'Unable to load templates. Please check your network.', 'error');
        }
    }

    async function openTemplateEditModal(key) {
        try {
            const res = await authenticatedFetch(`/api/admin/email/templates/${key}`);
            const template = await res.json();
            document.getElementById('editTemplateKey').value = key;
            document.getElementById('editTemplateKeyDisplay').value = key;
            document.getElementById('editTemplateKeyDisplay').disabled = true;
            document.getElementById('editTemplateSubject').value = template.subject || '';
            document.getElementById('editTemplateBody').value = template.body_html || '';
            document.getElementById('editTemplateActive').checked = template.is_active !== false;
            document.getElementById('templateEditModalTitle').textContent = `Edit Template: ${key}`;
            document.getElementById('templateEditModal').style.display = 'flex';
        } catch (err) {
            showAlertModal(err.message || 'Failed to load template details. Please refresh.', 'error');
        }
    }

    async function loadSettings() {
        const container = document.getElementById('settingsContainer');
        container.innerHTML = '<div class="text-center py-8 text-slate-400">Loading settings...</div>';
        try {
            const res = await authenticatedFetch('/api/admin/email/settings');
            const settings = await res.json();
            if (!settings.length) {
                container.innerHTML = '<div class="text-center py-8 text-slate-400">No settings found.</div>';
                return;
            }
            const categories = {
                user: { label: 'User Notifications', keys: ['send_otp', 'send_welcome_email', 'send_password_reset', 'send_account_locked'] },
                requests: { label: 'Request Notifications', keys: ['send_request_submitted', 'send_request_approved'] },
                admin: { label: 'Admin Alerts', keys: ['send_admin_new_registration', 'send_admin_new_key_request'] },
                reminders: { label: 'Reminders', keys: ['send_reminders'] },
                fines: { label: 'Fine Notifications', keys: ['send_fine_created', 'send_fine_paid'] }
            };
            let html = '';
            for (const [catKey, cat] of Object.entries(categories)) {
                html += `<div class="setting-category">${cat.label}</div>`;
                for (const settingKey of cat.keys) {
                    const setting = settings.find(s => s.setting_key === settingKey);
                    if (!setting) continue;
                    const config = setting.config || {};
                    let configControls = '';
                    if (settingKey === 'send_reminders') {
                        const days = config.reminder_days_before ? config.reminder_days_before.join(',') : '1,0';
                        const adminSummaryChecked = config.admin_summary_enabled !== false ? 'checked' : '';
                        const overdueChecked = config.send_overdue_reminders !== false ? 'checked' : '';
                        configControls = `
                            <div class="config-group">
                                <label>Remind days before due: <input type="text" data-key="${settingKey}" data-config="reminder_days_before" value="${escapeHtml(days)}" placeholder="e.g. 1,0" /></label>
                                <label><input type="checkbox" data-key="${settingKey}" data-config="admin_summary_enabled" ${adminSummaryChecked} /> Admin summary</label>
                                <label><input type="checkbox" data-key="${settingKey}" data-config="send_overdue_reminders" ${overdueChecked} /> Overdue reminders</label>
                            </div>
                        `;
                    } else {
                        if (Object.keys(config).length) {
                            configControls = `<span class="text-xs text-slate-400">${escapeHtml(JSON.stringify(config))}</span>`;
                        }
                    }
                    html += `
                        <div class="setting-item">
                            <div class="setting-label">${escapeHtml(settingKey.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()))}</div>
                            <div class="setting-control">
                                <input type="checkbox" class="setting-toggle" data-key="${settingKey}" ${setting.enabled ? 'checked' : ''} />
                                ${configControls}
                            </div>
                        </div>
                    `;
                }
            }
            container.innerHTML = html;
        } catch (err) {
            container.innerHTML = '<div class="text-center py-8 text-rose-600">Failed to load settings. Please refresh.</div>';
            showAlertModal(err.message || 'Unable to load notification settings. Please check your network.', 'error');
        }
    }

    async function loadLostKeysManagement() {
        const container = document.getElementById('lostKeysManagementContainer');
        if (!container) return;
        container.innerHTML = '<div class="text-center py-8 text-slate-400">Loading lost keys...</div>';
        try {
            const res = await authenticatedFetch('/api/admin/lost-keys');
            const data = await res.json();
            if (!data.length) {
                container.innerHTML = '<div class="text-center py-8 text-slate-400">No lost keys found.</div>';
                return;
            }
            let html = `<table class="table-clean"><thead><tr>
                <th class="text-left">Key Code</th>
                <th class="text-left">Brand</th>
                <th class="text-left">Borrower</th>
                <th>Lost Date</th>
                <th>Status</th>
                <th class="text-right">Actions</th>
            </tr></thead><tbody>`;
            for (const item of data) {
                const statusClass = item.resolved_at ? 'returned' : 'lost';
                const statusLabel = item.resolved_at ? 'Resolved' : 'Lost';
                html += `<tr>
                    <td class="text-left"><code>${escapeHtml(item.key_code)}</code></td>
                    <td class="text-left">${escapeHtml(item.brand)}</td>
                    <td class="text-left">${escapeHtml(item.borrower_name || item.borrower_email)}</td>
                    <td>${formatDate(item.lost_at)}</td>
                    <td><span class="status-badge ${statusClass}">${statusLabel}</span></td>
                    <td class="text-right">
                        <div class="actions-dropdown">
                            <button class="dropdown-toggle" data-id="${item.id}">
                                Actions <i class="fas fa-chevron-down"></i>
                            </button>
                            <div class="dropdown-menu" data-id="${item.id}">
                                <button class="dropdown-item btn-view view-lost-key-btn" data-id="${item.id}">
                                    <i class="fas fa-eye"></i> View
                                </button>
                                ${!item.resolved_at ? `
                                    <button class="dropdown-item btn-edit edit-lost-key-btn" data-id="${item.id}">
                                        <i class="fas fa-edit"></i> Edit
                                    </button>
                                    <button class="dropdown-item btn-success close-lost-ticket-btn" data-id="${item.id}" data-key="${escapeHtml(item.key_code)}">
                                        <i class="fas fa-check-circle"></i> Close Ticket
                                    </button>
                                ` : ''}
                                <button class="dropdown-item btn-warning make-available-btn" data-id="${item.id}" data-key="${escapeHtml(item.key_code)}">
                                    <i class="fas fa-check"></i> Make Available
                                </button>
                            </div>
                        </div>
                    </td>
                </tr>`;
            }
            html += `</tbody></table>`;
            container.innerHTML = html;

            container.querySelectorAll('.actions-dropdown').forEach(dropdown => {
                const toggle = dropdown.querySelector('.dropdown-toggle');
                const menu = dropdown.querySelector('.dropdown-menu');
                
                toggle.addEventListener('click', function(e) {
                    e.stopPropagation();
                    container.querySelectorAll('.dropdown-menu').forEach(m => {
                        if (m !== menu) m.classList.remove('show');
                    });
                    menu.classList.toggle('show');
                });
                
                menu.querySelectorAll('.dropdown-item').forEach(item => {
                    item.addEventListener('click', function(e) {
                        e.stopPropagation();
                        const id = parseInt(this.dataset.id);
                        const action = this.classList.contains('view-lost-key-btn') ? 'view' :
                            this.classList.contains('edit-lost-key-btn') ? 'edit' :
                            this.classList.contains('close-lost-ticket-btn') ? 'close-ticket' :
                            this.classList.contains('make-available-btn') ? 'make-available' : null;
                        if (action) {
                            menu.classList.remove('show');
                            const lostItem = data.find(d => d.id === id);
                            if (lostItem) {
                                if (action === 'view') {
                                    showLostKeyDetail(id);
                                } else if (action === 'edit') {
                                    openLostKeyEditModal(id);
                                } else if (action === 'close-ticket') {
                                    handleCloseTicket(id, this.dataset.key);
                                } else if (action === 'make-available') {
                                    handleMakeAvailable(id, this.dataset.key);
                                }
                            }
                        }
                    });
                });
            });
            
            document.addEventListener('click', function(e) {
                if (!e.target.closest('.actions-dropdown')) {
                    container.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
                }
            });
        } catch (err) {
            container.innerHTML = `<div class="text-center py-8 text-rose-600">Failed to load lost keys: ${escapeHtml(err.message)}</div>`;
            showAlertModal(err.message || 'Failed to load lost keys.', 'error');
        }
    }

    async function handleCloseTicket(id, key) {
        if (!confirm(`Close lost ticket for key ${key}? This will mark the issue as resolved.`)) return;
        const notes = prompt('Resolution notes (optional):');
        try {
            const res = await authenticatedFetch(`/api/admin/lost-keys/${id}/close`, {
                method: 'POST',
                body: JSON.stringify({ resolution_notes: notes || null })
            });
            if (res.ok) {
                await logAuditEvent('close_lost_ticket', 'lost_key', id, {
                    key_code: key,
                    resolution_notes: notes || null
                });
                showAlertModal('Ticket closed successfully.', 'success');
                loadLostKeysManagement();
                loadLostKeys();
            } else {
                const data = await res.json();
                showAlertModal(data.error || 'Failed to close ticket.', 'error');
            }
        } catch (err) {
            showAlertModal(err.message || 'Network error.', 'error');
        }
    }

    async function handleMakeAvailable(id, key) {
        if (!confirm(`Mark key ${key} as available again?`)) return;
        try {
            const res = await authenticatedFetch(`/api/admin/lost-keys/${id}/make-available`, {
                method: 'POST'
            });
            if (res.ok) {
                await logAuditEvent('make_key_available', 'lost_key', id, {
                    key_code: key
                });
                showAlertModal(`Key ${key} is now available.`, 'success');
                loadLostKeysManagement();
                loadLostKeys();
                loadInventory();
            } else {
                const data = await res.json();
                showAlertModal(data.error || 'Failed to make key available.', 'error');
            }
        } catch (err) {
            showAlertModal(err.message || 'Network error.', 'error');
        }
    }

    async function showLostKeyDetail(id) {
        const modal = document.getElementById('lostKeyDetailModal');
        const content = document.getElementById('lostKeyDetailContent');
        modal.style.display = 'flex';
        content.innerHTML = '<div class="text-center py-8 text-slate-400">Loading...</div>';
        try {
            const res = await authenticatedFetch(`/api/admin/lost-keys/${id}`);
            const data = await res.json();
            const statusClass = data.resolved_at ? 'returned' : 'lost';
            const statusLabel = data.resolved_at ? 'Resolved' : 'Lost';
            const formatAmount = (amount) => {
                const num = safeNumber(amount);
                return num.toFixed(2);
            };
            const html = `
                <div class="detail-section">
                    <div class="detail-label">Key Information</div>
                    <div class="detail-grid">
                        <div><span class="detail-label">Code</span><div class="detail-value">${escapeHtml(data.key_code)}</div></div>
                        <div><span class="detail-label">Brand</span><div class="detail-value">${escapeHtml(data.brand)}</div></div>
                        <div><span class="detail-label">Status</span><div class="detail-value"><span class="status-badge ${statusClass}">${statusLabel}</span></div></div>
                    </div>
                </div>
                <div class="detail-section">
                    <div class="detail-label">Borrower</div>
                    <div class="detail-grid">
                        <div><span class="detail-label">Name</span><div class="detail-value">${escapeHtml(data.borrower_name || '—')}</div></div>
                        <div><span class="detail-label">Email</span><div class="detail-value">${escapeHtml(data.borrower_email || '—')}</div></div>
                    </div>
                </div>
                <div class="detail-section">
                    <div class="detail-label">Lost Event</div>
                    <div class="detail-grid">
                        <div><span class="detail-label">Lost At</span><div class="detail-value">${formatDate(data.lost_at)}</div></div>
                        <div><span class="detail-label">Planned Return</span><div class="detail-value">${formatDate(data.planned_return)}</div></div>
                        ${data.returned_at ? `<div><span class="detail-label">Returned At</span><div class="detail-value">${formatDate(data.returned_at)}</div></div>` : ''}
                        <div class="full-width"><span class="detail-label">Reason for Loss</span><div class="detail-value">${escapeHtml(data.reason || '—')}</div></div>
                        ${data.resolved_at ? `<div><span class="detail-label">Resolved At</span><div class="detail-value">${formatDate(data.resolved_at)}</div></div>` : ''}
                    </div>
                </div>
                ${data.fine ? `
                <div class="detail-section">
                    <div class="detail-label">Fee</div>
                    <div class="detail-grid">
                        <div><span class="detail-label">Amount</span><div class="detail-value">$${formatAmount(data.fine.amount)}</div></div>
                        <div><span class="detail-label">Status</span><div class="detail-value"><span class="status-badge ${data.fine.status === 'paid' ? 'returned' : 'pending'}">${escapeHtml(data.fine.status || 'pending')}</span></div></div>
                        <div><span class="detail-label">Issued</span><div class="detail-value">${formatDate(data.fine.created_at)}</div></div>
                        ${data.fine.paid_at ? `<div><span class="detail-label">Paid At</span><div class="detail-value">${formatDate(data.fine.paid_at)}</div></div>` : ''}
                        ${data.fine.waived_at ? `<div><span class="detail-label">Waived At</span><div class="detail-value">${formatDate(data.fine.waived_at)}</div></div>` : ''}
                    </div>
                </div>` : ''}
            `;
            content.innerHTML = html;
            document.getElementById('lostKeyDetailTitle').textContent = `Lost Key: ${data.key_code}`;
        } catch (err) {
            content.innerHTML = `<div class="text-center py-8 text-rose-600">Unable to load details: ${escapeHtml(err.message || 'Please refresh and try again.')}</div>`;
            showAlertModal(err.message || 'Failed to load lost key details.', 'error');
        }
    }

    async function openLostKeyEditModal(id) {
        const modal = document.getElementById('lostKeyEditModal');
        modal.style.display = 'flex';
        try {
            const res = await authenticatedFetch(`/api/admin/lost-keys/${id}`);
            const data = await res.json();
            document.getElementById('editLostTransactionId').value = id;
            document.getElementById('editLostKeyCode').value = data.key_code || '';
            document.getElementById('editLostBrand').value = data.brand || '';
            document.getElementById('editLostBorrower').value = data.borrower_name || data.borrower_email || '';
            document.getElementById('editLostReason').value = data.reason || '';
            if (data.lost_at) {
                const date = new Date(data.lost_at);
                document.getElementById('editLostDate').value = date.toISOString().slice(0, 16);
            }
            document.getElementById('editLostStatus').value = data.resolved_at ? 'resolved' : 'lost';
            document.getElementById('lostKeyEditTitle').textContent = `Edit Lost Key: ${data.key_code}`;
        } catch (err) {
            showAlertModal(err.message || 'Failed to load lost key details.', 'error');
            modal.style.display = 'none';
        }
    }

    async function loadAdminRecipients() {
        const container = document.getElementById('adminRecipientsContainer');
        if (!container) return;
        container.innerHTML = '<div class="text-center py-8 text-slate-400">Loading recipients...</div>';
        try {
            const res = await authenticatedFetch('/api/admin/admin-notification-recipients');
            const recipients = await res.json();
            if (!recipients.length) {
                container.innerHTML = '<div class="text-center py-8 text-slate-400">No admin notification recipients configured. Add one to receive email notifications for key requests.</div>';
                return;
            }
            let html = `<table class="table-clean"><thead><tr>
                <th class="text-left">Name</th>
                <th class="text-left">Email</th>
                <th>Status</th>
                <th class="text-right">Actions</th>
            </tr></thead><tbody>`;
            for (const r of recipients) {
                const statusBadge = r.enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700';
                const statusLabel = r.enabled ? 'Active' : 'Disabled';
                html += `<tr>
                    <td class="text-left">${escapeHtml(r.name)}</td>
                    <td class="text-left">${escapeHtml(r.email)}</td>
                    <td><span class="status-badge ${statusBadge}">${statusLabel}</span></td>
                    <td class="text-right">
                        <div class="action-buttons" style="justify-content:flex-end;">
                            <button class="btn btn-secondary btn-sm toggle-admin-recipient" data-user-id="${r.id}" data-enabled="${r.enabled}">
                                <i class="fas ${r.enabled ? 'fa-pause' : 'fa-play'}"></i> ${r.enabled ? 'Disable' : 'Enable'}
                            </button>
                            <button class="btn btn-danger btn-sm delete-admin-recipient" data-user-id="${r.id}" data-name="${escapeHtml(r.name)}">
                                <i class="fas fa-trash"></i> Remove
                            </button>
                        </div>
                    </td>
                </tr>`;
            }
            html += `</tbody></table>`;
            container.innerHTML = html;

            document.querySelectorAll('.toggle-admin-recipient').forEach(btn => {
                btn.addEventListener('click', async function() {
                    const userId = parseInt(this.dataset.userId);
                    const currentEnabled = this.dataset.enabled === 'true';
                    const newEnabled = !currentEnabled;
                    try {
                        const res = await authenticatedFetch('/api/admin/admin-notification-recipients', {
                            method: 'POST',
                            body: JSON.stringify({ user_id: userId, enabled: newEnabled })
                        });
                        if (res.ok) {
                            await logAuditEvent('toggle_admin_recipient', 'admin_recipient', userId, {
                                enabled: newEnabled
                            });
                            showAlertModal(`Recipient ${newEnabled ? 'enabled' : 'disabled'}.`, 'success');
                            loadAdminRecipients();
                        } else {
                            const data = await res.json();
                            showAlertModal(data.error || 'Update failed.', 'error');
                        }
                    } catch (err) {
                        showAlertModal(err.message || 'Network error.', 'error');
                    }
                });
            });

            document.querySelectorAll('.delete-admin-recipient').forEach(btn => {
                btn.addEventListener('click', async function() {
                    const userId = parseInt(this.dataset.userId);
                    const name = this.dataset.name;
                    if (!confirm(`Remove ${name} from notification recipients?`)) return;
                    try {
                        const res = await authenticatedFetch(`/api/admin/admin-notification-recipients/${userId}`, { method: 'DELETE' });
                        if (res.ok) {
                            await logAuditEvent('delete_admin_recipient', 'admin_recipient', userId, {
                                name: name
                            });
                            showAlertModal('Recipient removed successfully.', 'success');
                            loadAdminRecipients();
                        } else {
                            const data = await res.json();
                            showAlertModal(data.error || 'Removal failed.', 'error');
                        }
                    } catch (err) {
                        showAlertModal(err.message || 'Network error.', 'error');
                    }
                });
            });
        } catch (err) {
            container.innerHTML = `<div class="text-center py-8 text-rose-600">Failed to load recipients: ${escapeHtml(err.message)}</div>`;
            showAlertModal(err.message || 'Failed to load admin notification recipients.', 'error');
        }
    }

    async function openAddAdminRecipientModal() {
        const modal = document.getElementById('addAdminRecipientModal');
        const select = document.getElementById('adminRecipientSelect');
        modal.style.display = 'flex';
        select.innerHTML = '<option value="">Loading...</option>';
        try {
            const res = await authenticatedFetch('/api/admin/admin-notification-recipients/available');
            const users = await res.json();
            if (!users.length) {
                select.innerHTML = '<option value="">No available admins</option>';
                return;
            }
            select.innerHTML = '<option value="">Select admin user...</option>';
            for (const user of users) {
                const opt = document.createElement('option');
                opt.value = user.id;
                opt.textContent = `${user.name} (${user.email})`;
                select.appendChild(opt);
            }
        } catch (err) {
            select.innerHTML = '<option value="">Error loading users</option>';
            showAlertModal(err.message || 'Failed to load available admins.', 'error');
        }
    }

    async function loadSecurityTab() {
        if (securityLoaded) return;
        securityLoaded = true;
        await Promise.all([loadAuditLogs(), loadAuditHealth(), loadPermissions(), loadRolesForUsers()]);
    }

    async function loadAuditLogs() {
        const tbody = document.getElementById('auditLogContainer');
        tbody.innerHTML = '<tr><td colspan="4" class="text-center py-8 text-slate-400">Loading audit logs...</td></tr>';
        try {
            const res = await authenticatedFetch('/api/audit/logs');
            const logs = await res.json();
            if (!logs.length) {
                tbody.innerHTML = '<tr><td colspan="4" class="text-center py-8 text-slate-400">No audit entries found.</td></tr>';
                return;
            }
            let html = '';
            for (const entry of logs) {
                html += `<tr class="audit-row" data-entry='${escapeHtml(JSON.stringify(entry))}'>
                    <td>${escapeHtml(entry.action || '')}</td>
                    <td>${escapeHtml(entry.target_type || '')}</td>
                    <td>${escapeHtml(entry.user_name || entry.user_email || 'System')}</td>
                    <td>${formatDate(entry.created_at)}</td>
                </tr>`;
            }
            tbody.innerHTML = html;
            tbody.querySelectorAll('.audit-row').forEach(row => {
                row.addEventListener('click', function() {
                    const entry = JSON.parse(this.dataset.entry);
                    showAuditDetail(entry);
                });
            });
        } catch (err) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-rose-600 text-center py-8">Unable to load audit logs. Please refresh.</td></tr>';
            showAlertModal(err.message || 'Failed to load audit logs. Please check your network.', 'error');
        }
    }

    function showAuditDetail(entry) {
        let detailsHtml = `<div class="space-y-4">
            <p><strong>Action:</strong> ${escapeHtml(entry.action)}</p>
            <p><strong>Target:</strong> ${escapeHtml(entry.target_type)} (ID: ${escapeHtml(entry.target_id || 'N/A')})</p>
            <p><strong>User:</strong> ${escapeHtml(entry.user_name || entry.user_email || 'System')}</p>
            <p><strong>Timestamp:</strong> ${formatDate(entry.created_at)}</p>`;
        if (entry.details) {
            detailsHtml += `<p><strong>Details:</strong> <pre class="bg-gray-100 p-2 rounded text-xs overflow-auto">${escapeHtml(typeof entry.details === 'string' ? entry.details : JSON.stringify(entry.details, null, 2))}</pre></p>`;
        }
        if (entry.old_data) {
            detailsHtml += `<p><strong>Old Data:</strong> <pre class="bg-gray-100 p-2 rounded text-xs overflow-auto">${escapeHtml(typeof entry.old_data === 'string' ? entry.old_data : JSON.stringify(entry.old_data, null, 2))}</pre></p>`;
        }
        if (entry.new_data) {
            detailsHtml += `<p><strong>New Data:</strong> <pre class="bg-gray-100 p-2 rounded text-xs overflow-auto">${escapeHtml(typeof entry.new_data === 'string' ? entry.new_data : JSON.stringify(entry.new_data, null, 2))}</pre></p>`;
        }
        detailsHtml += `</div>`;
        showDetailModal('Audit Entry Details', detailsHtml);
    }

    async function loadPermissions() {
        const container = document.getElementById('permissionsContainer');
        container.innerHTML = '<div class="text-center text-slate-400 py-8">Loading permissions...</div>';
        try {
            const [rolesRes, permsRes] = await Promise.all([
                authenticatedFetch('/api/permissions/roles'),
                authenticatedFetch('/api/permissions')
            ]);
            if (!rolesRes.ok || !permsRes.ok) throw new Error('Failed to load permissions data');
            const roleMappings = await rolesRes.json();
            const permissions = await permsRes.json();

            let normalizedMappings = {};
            if (Array.isArray(roleMappings)) {
                for (const item of roleMappings) {
                    const roleName = item.role || item.role_name || 'unknown';
                    const perms = item.permissions || item.permission_codes || [];
                    normalizedMappings[roleName] = Array.isArray(perms) ? perms : [];
                }
            } else if (roleMappings && typeof roleMappings === 'object') {
                normalizedMappings = roleMappings;
            } else {
                normalizedMappings = { admin: [] };
            }

            for (const key of Object.keys(normalizedMappings)) {
                if (!Array.isArray(normalizedMappings[key])) {
                    normalizedMappings[key] = [];
                }
            }

            permissionsData.roleMappings = normalizedMappings;
            permissionsData.permissions = Array.isArray(permissions) ? permissions : [];
            permissionsData.roles = Object.keys(normalizedMappings);
            renderPermissions();
        } catch (err) {
            container.innerHTML = `<div class="text-rose-600 text-center py-8">Error: ${escapeHtml(err.message)}</div>`;
            showAlertModal(err.message || 'Unable to load permissions. Please refresh.', 'error');
        }
    }

    function renderPermissions() {
        const container = document.getElementById('permissionsContainer');
        const { roles, permissions, roleMappings } = permissionsData;
        if (!permissions || permissions.length === 0) {
            container.innerHTML = '<div class="text-center py-8 text-amber-600">No permissions defined.</div>';
            return;
        }
        if (!roles || roles.length === 0) {
            container.innerHTML = '<div class="text-center py-8 text-amber-600">No roles found. Add roles to role_permissions.</div>';
            return;
        }

        let html = `<table class="table-clean"><thead><tr><th class="text-left">Role</th>`;
        for (const p of permissions) html += `<th>${escapeHtml(p.permission_name)}</th>`;
        html += `<th>Actions</th></tr></thead><tbody>`;

        for (const role of roles) {
            const perms = Array.isArray(roleMappings[role]) ? roleMappings[role] : [];
            html += `<tr><td class="text-left font-medium text-slate-800">${escapeHtml(role)}</td>`;
            for (const p of permissions) {
                const checked = perms.includes(p.permission_code) || perms.includes(String(p.permission_id)) ? 'checked' : '';
                html += `<td><input type="checkbox" class="permission-checkbox" data-role="${escapeHtml(role)}" data-perm-id="${p.permission_id}" ${checked}></td>`;
            }
            if (role.toLowerCase() === 'admin') {
                html += `<td><button class="btn btn-secondary btn-sm viewRoleBtn" data-role="${escapeHtml(role)}"><i class="fas fa-eye"></i> View</button></td>`;
            } else {
                html += `<td><button class="btn btn-danger btn-sm deleteRoleBtn" data-role="${escapeHtml(role)}"><i class="fas fa-trash"></i> Delete</button></td>`;
            }
            html += `</tr>`;
        }
        html += `</tbody></table>`;
        container.innerHTML = html;

        document.querySelectorAll('.deleteRoleBtn').forEach(btn => {
            btn.addEventListener('click', function() {
                const role = this.dataset.role;
                if (confirm(`Delete role "${role}"?`)) {
                    delete permissionsData.roleMappings[role];
                    permissionsData.roles = Object.keys(permissionsData.roleMappings);
                    renderPermissions();
                    showAlertModal(`Role "${role}" removed.`, 'info');
                }
            });
        });

        document.querySelectorAll('.viewRoleBtn').forEach(btn => {
            btn.addEventListener('click', function() {
                const role = this.dataset.role;
                const perms = Array.isArray(permissionsData.roleMappings[role]) ? permissionsData.roleMappings[role] : [];
                const permNames = permissionsData.permissions
                    .filter(p => perms.includes(p.permission_code) || perms.includes(String(p.permission_id)))
                    .map(p => p.permission_name)
                    .join(', ') || 'No permissions assigned';
                showDetailModal(`Permissions for "${role}"`, `
                    <div class="p-4">
                        <p><strong>Role:</strong> ${escapeHtml(role)}</p>
                        <p><strong>Permissions:</strong> ${escapeHtml(permNames)}</p>
                        <p class="text-xs text-slate-500 mt-2">System admin role – cannot be deleted.</p>
                    </div>
                `);
            });
        });

        document.querySelectorAll('.permission-checkbox').forEach(cb => {
            cb.style.pointerEvents = 'auto';
            cb.style.cursor = 'pointer';
            cb.style.opacity = '1';
            cb.disabled = false;
        });
    }

    async function loadRolesForUsers() {
        try {
            const res = await authenticatedFetch('/api/permissions/roles');
            const data = await res.json();
            const roleNames = Object.keys(data || {});
            allRolesList = roleNames;
            populateRoleDropdowns(roleNames);
        } catch (err) {
            showAlertModal(err.message || 'Failed to load roles. Please refresh.', 'error');
        }
    }

    function populateRoleDropdowns(roles) {
        const filterSelect = document.getElementById('acmRoleFilter');
        if (filterSelect) {
            filterSelect.innerHTML = '<option value="all">All roles</option>';
            roles.forEach(role => {
                const opt = document.createElement('option');
                opt.value = role;
                opt.textContent = role;
                filterSelect.appendChild(opt);
            });
        }
        const modalSelect = document.getElementById('acmRole');
        if (modalSelect) {
            modalSelect.innerHTML = '<option value="">Select role...</option>';
            roles.forEach(role => {
                const opt = document.createElement('option');
                opt.value = role;
                opt.textContent = role;
                modalSelect.appendChild(opt);
            });
        }
        const manageRoleFilter = document.getElementById('manageUserRoleFilter');
        if (manageRoleFilter) {
            manageRoleFilter.innerHTML = '<option value="all">All roles</option>';
            roles.forEach(role => {
                const opt = document.createElement('option');
                opt.value = role;
                opt.textContent = role;
                manageRoleFilter.appendChild(opt);
            });
        }
    }

    async function loadPendingRegistrations() {
        const container = document.getElementById('pendingRequestsContainer');
        container.innerHTML = '<div class="text-center py-8 text-slate-400">Loading requests...</div>';
        try {
            const res = await authenticatedFetch('/api/auth/admin/pending-requests');
            const requests = await res.json();
            if (!requests.length) {
                container.innerHTML = '<div class="text-center py-8 text-slate-400">No pending requests.</div>';
                return;
            }
            let html = `<table class="table-clean"><thead><tr>
                <th class="text-left">Name</th>
                <th class="text-left">Email</th>
                <th>Username</th>
                <th>Requested</th>
                <th>Actions</th>
            </tr></thead><tbody>`;
            for (const req of requests) {
                html += `<tr>
                    <td class="text-left">${escapeHtml(req.name)}</td>
                    <td class="text-left">${escapeHtml(req.email)}</td>
                    <td>${escapeHtml(req.username || '—')}</td>
                    <td>${formatDate(req.created_at)}</td>
                    <td>
                        <div class="action-buttons">
                            <button class="btn btn-success approveRequestBtn" data-id="${req.id}"><i class="fas fa-check"></i> Approve</button>
                            <button class="btn btn-danger rejectRequestBtn" data-id="${req.id}"><i class="fas fa-times"></i> Reject</button>
                        </div>
                    </td>
                </tr>`;
            }
            html += `</tbody></table>`;
            container.innerHTML = html;
            container.querySelectorAll('.approveRequestBtn').forEach(btn => {
                btn.addEventListener('click', async function() {
                    const id = this.dataset.id;
                    if (confirm('Approve this registration request? The user will receive a password via email.')) {
                        try {
                            const res = await authenticatedFetch(`/api/auth/admin/pending-requests/${id}/approve`, { method: 'POST' });
                            const data = await res.json();
                            if (res.ok) {
                                await logAuditEvent('registration_approved', 'registration_request', id, {
                                    user_name: data.name,
                                    user_email: data.email,
                                    approved_by: getUser()?.name || 'Admin'
                                });
                                showAlertModal(data.message || 'User approved. Password sent.', 'success');
                                loadPendingRegistrations();
                            } else {
                                showAlertModal(data.error || 'Approval failed. Please try again.', 'error');
                            }
                        } catch (err) {
                            showAlertModal(err.message || 'Network error. Please check your connection.', 'error');
                        }
                    }
                });
            });
            container.querySelectorAll('.rejectRequestBtn').forEach(btn => {
                btn.addEventListener('click', async function() {
                    const id = this.dataset.id;
                    const reason = prompt('Optional reason for rejection:');
                    if (confirm('Reject this registration request?')) {
                        try {
                            const res = await authenticatedFetch(`/api/auth/admin/pending-requests/${id}/reject`, {
                                method: 'POST',
                                body: JSON.stringify({ reason: reason || null })
                            });
                            const data = await res.json();
                            if (res.ok) {
                                await logAuditEvent('registration_rejected', 'registration_request', id, {
                                    reason: reason || 'No reason provided',
                                    rejected_by: getUser()?.name || 'Admin'
                                });
                                showAlertModal('Request rejected successfully.', 'success');
                                loadPendingRegistrations();
                            } else {
                                showAlertModal(data.error || 'Rejection failed. Please try again.', 'error');
                            }
                        } catch (err) {
                            showAlertModal(err.message || 'Network error. Please check your connection.', 'error');
                        }
                    }
                });
            });
        } catch (err) {
            container.innerHTML = '<div class="text-center py-8 text-rose-600">Failed to load requests. Please refresh the page.</div>';
            showAlertModal(err.message || 'Unable to load pending requests. Please check your internet connection.', 'error');
        }
    }

    function initUserManagement() {
        const tbody = document.getElementById('acmUserTableBody');
        const searchInput = document.getElementById('acmSearchInput');
        const roleFilter = document.getElementById('acmRoleFilter');
        const statusFilter = document.getElementById('acmStatusFilter');
        const resetBtn = document.getElementById('acmResetFiltersBtn');
        const prevBtn = document.getElementById('acmPrevPageBtn');
        const nextBtn = document.getElementById('acmNextPageBtn');
        const paginationInfo = document.getElementById('acmPaginationInfo');
        let allUsers = [], filteredUsers = [], currentPage = 1, rowsPerPage = 5, totalUsers = 0;

        const manageModal = document.getElementById('userManagementModal');
        const manageTbody = document.getElementById('manageUserTableBody');
        const manageSearch = document.getElementById('manageUserSearch');
        const manageRoleFilter = document.getElementById('manageUserRoleFilter');
        const manageStatusFilter = document.getElementById('manageUserStatusFilter');
        const manageResetBtn = document.getElementById('resetManageUserFilters');
        const managePrevBtn = document.getElementById('manageUserPrevBtn');
        const manageNextBtn = document.getElementById('manageUserNextBtn');
        const managePaginationInfo = document.getElementById('manageUserPaginationInfo');
        const addUserFromManageBtn = document.getElementById('addUserFromManageBtn');
        const manageTotalLabel = document.getElementById('manageUserTotalLabel');
        let manageUsers = [], manageFiltered = [], managePage = 1, manageRows = 5, manageTotal = 0;

        document.getElementById('openUserManagementBtn')?.addEventListener('click', () => {
            manageModal.style.display = 'flex';
            fetchManageUsers();
        });
        document.getElementById('closeUserManagementModalBtn')?.addEventListener('click', () => {
            manageModal.style.display = 'none';
        });
        manageModal?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                manageModal.style.display = 'none';
            }
        });

        async function fetchUsersInline() {
            const search = searchInput.value.trim(), role = roleFilter.value, status = statusFilter.value;
            const params = new URLSearchParams();
            if (search) params.append('search', search);
            if (role !== 'all') params.append('role', role);
            if (status !== 'all') params.append('status', status);
            params.append('page', currentPage);
            params.append('limit', rowsPerPage);
            params.append('_', Date.now());
            try {
                const res = await authenticatedFetch(`/api/admin/users?${params.toString()}`, { cache: 'no-store' });
                const data = await res.json();
                allUsers = data.users || [];
                totalUsers = data.total || 0;
                filteredUsers = allUsers;
                renderInlineTable();
                updateInlinePagination();
            } catch (err) {
                tbody.innerHTML = `<tr><td colspan="4" class="text-center py-8 text-rose-600">Unable to load users. Please refresh.</td></tr>`;
                showAlertModal(err.message || 'Failed to load users. Please check your network.', 'error');
            }
        }

        function renderInlineTable() {
            if (!filteredUsers.length) {
                tbody.innerHTML = '<tr><td colspan="4" class="text-center py-8 text-slate-400">No users found</td></tr>';
                return;
            }
            let html = '';
            for (const user of filteredUsers) {
                const statusBadge = user.status === 'active' ? 'bg-emerald-100 text-emerald-700' :
                    user.status === 'suspended' ? 'bg-rose-100 text-rose-700' :
                    user.status === 'locked' ? 'bg-amber-100 text-amber-700' : 'bg-amber-100 text-amber-700';
                const statusLabel = user.status.charAt(0).toUpperCase() + user.status.slice(1);
                const initials = getInitials(user.name);
                const avatarColor = getAvatarColor(user.name);
                html += `
                    <tr class="hover:bg-slate-50 transition">
                        <td class="text-left">
                            <div class="flex items-center gap-3">
                                <div class="acm-avatar-initials" style="background-color:${avatarColor};">${escapeHtml(initials)}</div>
                                <div>
                                    <div class="text-sm font-medium text-slate-800">${escapeHtml(user.name)}</div>
                                    <div class="text-sm text-slate-500">${escapeHtml(user.email)}</div>
                                </div>
                            </div>
                        </td>
                        <td>${escapeHtml(user.role)}</td>
                        <td><span class="status-badge ${statusBadge}">${statusLabel}</span></td>
                        <td>${formatLastActive(user.lastActive)}</td>
                    </tr>
                `;
            }
            tbody.innerHTML = html;
        }

        function updateInlinePagination() {
            const start = (currentPage - 1) * rowsPerPage + 1;
            const end = Math.min(currentPage * rowsPerPage, totalUsers);
            paginationInfo.innerText = totalUsers === 0 ? 'Showing 0 of 0 users' : `Showing ${start}–${end} of ${totalUsers} users`;
            const totalPages = Math.ceil(totalUsers / rowsPerPage);
            prevBtn.disabled = currentPage === 1 || totalPages === 0;
            nextBtn.disabled = currentPage === totalPages || totalPages === 0;
        }

        searchInput?.addEventListener('input', () => { currentPage = 1; fetchUsersInline(); });
        roleFilter?.addEventListener('change', () => { currentPage = 1; fetchUsersInline(); });
        statusFilter?.addEventListener('change', () => { currentPage = 1; fetchUsersInline(); });
        resetBtn?.addEventListener('click', () => { searchInput.value = ''; roleFilter.value = 'all'; statusFilter.value = 'all'; currentPage = 1; fetchUsersInline(); });
        prevBtn?.addEventListener('click', () => { if (currentPage > 1) { currentPage--; fetchUsersInline(); } });
        nextBtn?.addEventListener('click', () => { const totalPages = Math.ceil(totalUsers / rowsPerPage); if (currentPage < totalPages) { currentPage++; fetchUsersInline(); } });
        document.getElementById('acmRowsPerPage')?.addEventListener('change', function() {
            rowsPerPage = parseInt(this.value);
            currentPage = 1;
            fetchUsersInline();
        });

        fetchUsersInline();

        const userModal = document.getElementById('acmUserModal');
        const modalTitle = document.getElementById('acmModalTitle');
        const closeModalBtn = document.getElementById('acmCloseModalBtn');
        const cancelModalBtn = document.getElementById('acmCancelModalBtn');
        const saveUserBtn = document.getElementById('acmSaveUserBtn');
        const deleteConfirmModal = document.getElementById('acmDeleteConfirmModal');
        const cancelDeleteBtn = document.getElementById('acmCancelDeleteBtn');
        const confirmDeleteBtn = document.getElementById('acmConfirmDeleteBtn');
        let editUserId = null, deleteUserId = null;

        async function fetchManageUsers() {
            const search = manageSearch.value.trim(), role = manageRoleFilter.value, status = manageStatusFilter.value;
            const params = new URLSearchParams();
            if (search) params.append('search', search);
            if (role !== 'all') params.append('role', role);
            if (status !== 'all') params.append('status', status);
            params.append('page', managePage);
            params.append('limit', manageRows);
            params.append('_', Date.now());
            try {
                const res = await authenticatedFetch(`/api/admin/users?${params.toString()}`, { cache: 'no-store' });
                const data = await res.json();
                manageUsers = data.users || [];
                manageTotal = data.total || 0;
                manageFiltered = manageUsers;
                renderManageTable();
                updateManagePagination();
                if (manageTotalLabel) manageTotalLabel.textContent = `Total: ${manageTotal}`;
            } catch (err) {
                manageTbody.innerHTML = `<tr><td colspan="5" class="text-center py-8 text-rose-600">Unable to load users. Please refresh.</td></tr>`;
                showAlertModal(err.message || 'Failed to load users. Please check your network.', 'error');
            }
        }

        function renderManageTable() {
            if (!manageFiltered.length) {
                manageTbody.innerHTML = '<tr><td colspan="5" class="text-center py-8 text-slate-400">No users found</td></tr>';
                return;
            }
            let html = '';
            for (const user of manageFiltered) {
                const statusBadge = user.status === 'active' ? 'bg-emerald-100 text-emerald-700' :
                    user.status === 'suspended' ? 'bg-rose-100 text-rose-700' :
                    user.status === 'locked' ? 'bg-amber-100 text-amber-700' : 'bg-amber-100 text-amber-700';
                const statusLabel = user.status.charAt(0).toUpperCase() + user.status.slice(1);
                const initials = getInitials(user.name);
                const avatarColor = getAvatarColor(user.name);
                html += `
                    <tr class="hover:bg-slate-50 transition">
                        <td class="text-left">
                            <div class="flex items-center gap-3">
                                <div class="acm-avatar-initials" style="background-color:${avatarColor};">${escapeHtml(initials)}</div>
                                <div>
                                    <div class="text-sm font-medium text-slate-800">${escapeHtml(user.name)}</div>
                                    <div class="text-sm text-slate-500">${escapeHtml(user.email)}</div>
                                </div>
                            </div>
                        </td>
                        <td>${escapeHtml(user.role)}</td>
                        <td><span class="status-badge ${statusBadge}">${statusLabel}</span></td>
                        <td>${formatLastActive(user.lastActive)}</td>
                        <td class="actions-cell">
                            <div class="actions-dropdown">
                                <button class="dropdown-toggle manageActionDots" data-user-id="${user.id}">
                                    Actions <i class="fas fa-chevron-down"></i>
                                </button>
                                <div class="dropdown-menu" data-user-id="${user.id}">
                                    <button class="dropdown-item manageEditUserBtn" data-user-id="${user.id}">
                                        <i class="fas fa-edit"></i> Edit
                                    </button>
                                    <button class="dropdown-item manageSuspendUserBtn" data-user-id="${user.id}" data-status="${user.status}">
                                        <i class="fas fa-ban"></i> ${user.status === 'suspended' ? 'Unsuspend' : 'Suspend'}
                                    </button>
                                    ${user.status === 'locked' ? `
                                        <button class="dropdown-item manageUnlockUserBtn" data-user-id="${user.id}">
                                            <i class="fas fa-unlock"></i> Unlock
                                        </button>
                                    ` : ''}
                                    <div class="dropdown-divider"></div>
                                    <button class="dropdown-item manageDeleteUserBtn text-rose-600" data-user-id="${user.id}">
                                        <i class="fas fa-trash"></i> Delete
                                    </button>
                                </div>
                            </div>
                        </td>
                    </tr>
                `;
            }
            manageTbody.innerHTML = html;
            attachManageEvents();
        }

        function attachManageEvents() {
            document.querySelectorAll('.manageActionDots').forEach(btn => {
                btn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    const menu = this.closest('.actions-dropdown').querySelector('.dropdown-menu');
                    document.querySelectorAll('.manage-action-menu, .dropdown-menu').forEach(m => {
                        if (m !== menu) m.classList.remove('show');
                    });
                    menu.classList.toggle('show');
                });
            });

            document.addEventListener('click', function(e) {
                if (!e.target.closest('.actions-dropdown')) {
                    document.querySelectorAll('.manage-action-menu, .dropdown-menu').forEach(m => m.classList.remove('show'));
                }
            });

            document.querySelectorAll('.manageEditUserBtn').forEach(btn => {
                btn.addEventListener('click', function() {
                    const userId = parseInt(this.dataset.userId);
                    const user = manageUsers.find(u => u.id === userId);
                    if (!user) return;
                    editUserId = userId;
                    document.getElementById('acmFullName').value = user.name;
                    document.getElementById('acmEmail').value = user.email;
                    document.getElementById('acmRole').value = user.role;
                    document.getElementById('acmStatus').value = user.status;
                    modalTitle.innerText = 'Edit User';
                    userModal.classList.add('active');
                    manageModal.style.display = 'none';
                    document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
                });
            });

            document.querySelectorAll('.manageSuspendUserBtn').forEach(btn => {
                btn.addEventListener('click', async function() {
                    const userId = parseInt(this.dataset.userId);
                    const user = manageUsers.find(u => u.id === userId);
                    if (!user) return;
                    try {
                        const res = await authenticatedFetch(`/api/admin/users/${userId}/suspend`, { method: 'PATCH' });
                        const data = await res.json();
                        await logAuditEvent('toggle_user_suspend', 'user', userId, {
                            status: data.status,
                            user_name: user.name
                        });
                        showAlertModal(`User ${user.name} ${data.status === 'suspended' ? 'suspended' : 'activated'}.`, 'success');
                        fetchManageUsers();
                        fetchUsersInline();
                    } catch (err) {
                        showAlertModal(err.message || 'Network error. Please check your connection.', 'error');
                    }
                    document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
                });
            });

            document.querySelectorAll('.manageUnlockUserBtn').forEach(btn => {
                btn.addEventListener('click', async function() {
                    const userId = parseInt(this.dataset.userId);
                    const user = manageUsers.find(u => u.id === userId);
                    if (!user) return;
                    if (!confirm(`Unlock account for ${user.name}?`)) return;
                    try {
                        await authenticatedFetch(`/api/admin/users/${userId}/unlock`, { method: 'POST' });
                        await logAuditEvent('unlock_user', 'user', userId, {
                            user_name: user.name
                        });
                        showAlertModal(`User ${user.name} unlocked successfully.`, 'success');
                        fetchManageUsers();
                        fetchUsersInline();
                    } catch (err) {
                        showAlertModal(err.message || 'Network error. Please check your connection.', 'error');
                    }
                    document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
                });
            });

            document.querySelectorAll('.manageDeleteUserBtn').forEach(btn => {
                btn.addEventListener('click', function() {
                    const userId = parseInt(this.dataset.userId);
                    const user = manageUsers.find(u => u.id === userId);
                    if (user) {
                        deleteUserId = userId;
                        document.getElementById('acmDeleteUserMessage').innerHTML = `Are you sure you want to delete <strong>${escapeHtml(user.name)}</strong>? This action cannot be undone.`;
                        deleteConfirmModal.classList.add('active');
                    }
                    document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
                });
            });
        }

        function updateManagePagination() {
            const start = (managePage - 1) * manageRows + 1;
            const end = Math.min(managePage * manageRows, manageTotal);
            managePaginationInfo.innerText = manageTotal === 0 ? 'Showing 0 of 0 users' : `Showing ${start}–${end} of ${manageTotal} users`;
            const totalPages = Math.ceil(manageTotal / manageRows);
            managePrevBtn.disabled = managePage === 1 || totalPages === 0;
            manageNextBtn.disabled = managePage === totalPages || totalPages === 0;
        }

        manageSearch?.addEventListener('input', () => { managePage = 1; fetchManageUsers(); });
        manageRoleFilter?.addEventListener('change', () => { managePage = 1; fetchManageUsers(); });
        manageStatusFilter?.addEventListener('change', () => { managePage = 1; fetchManageUsers(); });
        manageResetBtn?.addEventListener('click', () => { manageSearch.value = ''; manageRoleFilter.value = 'all'; manageStatusFilter.value = 'all'; managePage = 1; fetchManageUsers(); });
        managePrevBtn?.addEventListener('click', () => { if (managePage > 1) { managePage--; fetchManageUsers(); } });
        manageNextBtn?.addEventListener('click', () => { const totalPages = Math.ceil(manageTotal / manageRows); if (managePage < totalPages) { managePage++; fetchManageUsers(); } });

        addUserFromManageBtn?.addEventListener('click', () => { resetForm(); openUserModal(); manageModal.style.display = 'none'; });

        function closeUserModal() { userModal.classList.remove('active'); }
        function openUserModal() { userModal.classList.add('active'); }
        function resetForm() { editUserId = null; document.getElementById('acmFullName').value = ''; document.getElementById('acmEmail').value = ''; document.getElementById('acmRole').value = ''; document.getElementById('acmStatus').value = 'active'; modalTitle.innerText = 'Add New User'; }

        async function saveUser() {
            const name = document.getElementById('acmFullName').value.trim();
            const email = document.getElementById('acmEmail').value.trim();
            const role = document.getElementById('acmRole').value;
            const status = document.getElementById('acmStatus').value;
            if (!name || !email) { showAlertModal('Name and email are required', 'error'); return; }
            if (!role) { showAlertModal('Please select a role.', 'error'); return; }
            saveUserBtn.disabled = true;
            saveUserBtn.innerText = 'Saving...';
            try {
                const payload = { name, email, role, status };
                let res;
                if (editUserId) {
                    res = await authenticatedFetch(`/api/admin/users/${editUserId}`, { method: 'PUT', body: JSON.stringify(payload) });
                } else {
                    res = await authenticatedFetch('/api/admin/users', { method: 'POST', body: JSON.stringify(payload) });
                }
                const data = await res.json();
                if (res.ok) {
                    await logAuditEvent(editUserId ? 'update_user' : 'create_user', 'user', data.id || editUserId, {
                        user_name: name,
                        user_email: email,
                        role: role,
                        status: status
                    });
                    showAlertModal(editUserId ? 'User updated successfully.' : `User ${data.name} created successfully.`, 'success');
                    closeUserModal();
                    fetchUsersInline();
                    fetchManageUsers();
                } else {
                    showAlertModal(data.error || 'Operation failed. Please try again.', 'error');
                }
            } catch (err) {
                showAlertModal(err.message || 'Network error. Please check your connection.', 'error');
            } finally {
                saveUserBtn.disabled = false;
                saveUserBtn.innerText = 'Save User';
            }
        }

        function closeDeleteModal() { deleteConfirmModal.classList.remove('active'); }
        async function confirmDelete() {
            if (!deleteUserId) return;
            confirmDeleteBtn.disabled = true;
            confirmDeleteBtn.innerText = 'Deleting...';
            try {
                await authenticatedFetch(`/api/admin/users/${deleteUserId}`, { method: 'DELETE' });
                await logAuditEvent('delete_user', 'user', deleteUserId, {
                    user_id: deleteUserId
                });
                showAlertModal('User deleted successfully.', 'success');
                closeDeleteModal();
                deleteUserId = null;
                fetchUsersInline();
                fetchManageUsers();
            } catch (err) {
                showAlertModal(err.message || 'Network error. Please check your connection.', 'error');
            } finally {
                confirmDeleteBtn.disabled = false;
                confirmDeleteBtn.innerText = 'Delete';
            }
        }

        closeModalBtn?.addEventListener('click', closeUserModal);
        cancelModalBtn?.addEventListener('click', closeUserModal);
        saveUserBtn?.addEventListener('click', saveUser);
        cancelDeleteBtn?.addEventListener('click', closeDeleteModal);
        confirmDeleteBtn?.addEventListener('click', confirmDelete);
        userModal?.addEventListener('click', (e) => { if (e.target === userModal) closeUserModal(); });
        deleteConfirmModal?.addEventListener('click', (e) => { if (e.target === deleteConfirmModal) closeDeleteModal(); });
    }

    async function handleLogout() {
        if (isRedirecting) return;
        isRedirecting = true;

        try {
            const token = getToken();
            if (token) {
                await fetch('/api/auth/logout', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        'Cache-Control': 'no-cache, no-store'
                    },
                    credentials: 'include'
                }).catch(() => {});
            }
        } catch (error) {
            console.error('Logout error:', error);
        } finally {
            window.location.replace('/force-logout');
        }
    }

    function initEventListeners() {
        document.getElementById('alertOkBtn')?.addEventListener('click', closeAlertModal);
        document.getElementById('alertModal')?.addEventListener('click', function(e) {
            if (e.target === this) closeAlertModal();
        });

        document.getElementById('closeDetailModalBtn')?.addEventListener('click', closeDetailModal);
        document.getElementById('closeDetailModalFooterBtn')?.addEventListener('click', closeDetailModal);
        document.getElementById('detailModal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) closeDetailModal();
        });

        document.getElementById('brandHomeLink')?.addEventListener('click', function(e) {
            e.preventDefault();
            document.querySelector('.tab-button[data-tab="dashboard"]')?.click();
        });

        const profileBtn = document.getElementById('userProfileBtn');
        const userDropdown = document.getElementById('userDropdown');
        if (profileBtn && userDropdown) {
            profileBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                this.classList.toggle('open');
                userDropdown.classList.toggle('show');
            });
            document.addEventListener('click', function(e) {
                if (!e.target.closest('.user-profile')) {
                    profileBtn.classList.remove('open');
                    userDropdown.classList.remove('show');
                }
            });
        }

        const mobileMenuBtn = document.getElementById('mobileMenuBtn');
        const mobileMenu = document.getElementById('mobileMenu');
        if (mobileMenuBtn && mobileMenu) {
            mobileMenuBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                mobileMenu.classList.toggle('open');
            });
            document.addEventListener('click', function(e) {
                if (!e.target.closest('.top-nav')) {
                    mobileMenu.classList.remove('open');
                }
            });
        }

        document.getElementById('mobileLogoutBtn')?.addEventListener('click', handleLogout);
        document.getElementById('logoutBtn')?.addEventListener('click', handleLogout);

        document.getElementById('myProfileBtn')?.addEventListener('click', openProfileModal);
        document.getElementById('mobileProfileBtn')?.addEventListener('click', openProfileModal);

        document.getElementById('closeProfileModalBtn')?.addEventListener('click', () => {
            document.getElementById('profileModal').style.display = 'none';
        });
        document.getElementById('cancelProfileBtn')?.addEventListener('click', () => {
            document.getElementById('profileModal').style.display = 'none';
        });
        document.getElementById('profileModal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                document.getElementById('profileModal').style.display = 'none';
            }
        });

        document.getElementById('saveProfileBtn')?.addEventListener('click', async function() {
            const name = document.getElementById('profileName').value.trim();
            const email = document.getElementById('profileEmail').value.trim();
            const currentPassword = document.getElementById('profileCurrentPassword').value.trim();
            const newPassword = document.getElementById('profilePassword').value.trim();

            if (!name || !email) {
                showAlertModal('Name and email are required.', 'error');
                return;
            }

            const payload = { name, email };
            if (newPassword) {
                if (!currentPassword) {
                    showAlertModal('Current password is required to change password.', 'error');
                    return;
                }
                payload.current_password = currentPassword;
                payload.new_password = newPassword;
            }

            try {
                const res = await authenticatedFetch('/api/user/profile', {
                    method: 'PUT',
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                if (res.ok) {
                    await logAuditEvent('update_profile', 'user_profile', 'self', {
                        name: name,
                        email: email
                    });
                    showAlertModal('Profile updated successfully.', 'success');
                    const user = getUser();
                    if (user) {
                        user.name = name;
                        user.email = email;
                        localStorage.setItem('kms_user', JSON.stringify(user));
                        updateUserDisplay();
                    }
                    document.getElementById('profileModal').style.display = 'none';
                } else {
                    showAlertModal(data.error || 'Failed to update profile. Please try again.', 'error');
                }
            } catch (err) {
                showAlertModal(err.message || 'Network error. Please check your connection.', 'error');
            }
        });

        document.querySelectorAll('.tab-button').forEach(btn => {
            btn.addEventListener('click', function() {
                document.querySelectorAll('.tab-button').forEach(b => b.classList.remove('active'));
                this.classList.add('active');
                const tabId = this.dataset.tab;
                document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
                const panel = document.getElementById('tab-' + tabId);
                if (panel) panel.classList.add('active');
                if (tabId === 'security') {
                    const first = document.querySelector('#tab-security .sub-tab-button');
                    if (first) first.click();
                    loadSecurityTab();
                } else if (tabId === 'email') {
                    const first = document.querySelector('#tab-email .sub-tab-button');
                    if (first) first.click();
                    loadEmailTab();
                } else if (tabId === 'requests') {
                    loadPendingRegistrations();
                } else if (tabId === 'inventory') {
                    loadInventory();
                } else if (tabId === 'lost') {
                    loadLostKeysManagement();
                }
            });
        });

        document.querySelectorAll('.sub-tab-button').forEach(btn => {
            btn.addEventListener('click', function() {
                document.querySelectorAll('.sub-tab-button').forEach(b => b.classList.remove('active'));
                this.classList.add('active');
                document.querySelectorAll('.sub-tab-panel').forEach(p => p.classList.remove('active'));
                const panel = document.getElementById('sub-' + this.dataset.subtab);
                if (panel) panel.classList.add('active');
                if (this.dataset.subtab === 'templates') loadTemplates();
                if (this.dataset.subtab === 'settings') loadSettings();
                if (this.dataset.subtab === 'admin-notifications') loadAdminRecipients();
            });
        });

        document.getElementById('refreshRequestsBtn')?.addEventListener('click', loadPendingRegistrations);

        document.getElementById('transactionsRowsPerPage')?.addEventListener('change', function() {
            txRows = parseInt(this.value);
            txPage = 1;
            applyTransactionFilters();
        });

        document.getElementById('transactionsPrevPageBtn')?.addEventListener('click', () => {
            if (txPage > 1) {
                txPage--;
                renderTransactionsTable();
                updateTransactionPagination();
            }
        });

        document.getElementById('transactionsNextPageBtn')?.addEventListener('click', () => {
            const totalPages = Math.ceil(txTotal / txRows);
            if (txPage < totalPages) {
                txPage++;
                renderTransactionsTable();
                updateTransactionPagination();
            }
        });

        document.getElementById('pendingRequestsCard')?.addEventListener('click', showPendingRequestsModal);
        document.getElementById('pendingKeyRequestsCard')?.addEventListener('click', showPendingRequestsModal);
        document.getElementById('pendingReturnsCard')?.addEventListener('click', showPendingReturnsModal);
        document.getElementById('activeBorrowsCard')?.addEventListener('click', showActiveBorrowsModal);
        document.getElementById('returnRemindersCard')?.addEventListener('click', showReturnRemindersModal);
        document.getElementById('lostKeysCard')?.addEventListener('click', showLostKeysModal);

        document.getElementById('refreshAuditBtn')?.addEventListener('click', loadAuditHealth);

        document.getElementById('modalConfirmBtn')?.addEventListener('click', async function() {
            const notes = document.getElementById('modalNotes').value.trim();
            const action = currentAction;
            const id = currentRequestId;
            const endpoint = action === 'approve' ? '/api/admin/requests/approve' : '/api/admin/requests/deny';
            try {
                const res = await authenticatedFetch(endpoint, {
                    method: 'POST',
                    body: JSON.stringify({ request_id: id, admin_notes: notes || null })
                });
                const data = await res.json();
                if (res.ok) {
                    await logAuditEvent(action === 'approve' ? 'approve_request' : 'deny_request', 'request', id, {
                        admin_notes: notes || null
                    });
                    showAlertModal(action === 'approve' ? 'Request approved.' : 'Request denied.', 'success');
                    document.getElementById('adminModal').style.display = 'none';
                    loadPendingRequests();
                    loadTransactions();
                    loadPendingReturns();
                } else {
                    showAlertModal(data.error || 'Action failed. Please try again.', 'error');
                }
            } catch (err) {
                showAlertModal(err.message || 'Network error. Please check your connection.', 'error');
            }
        });

        document.getElementById('modalCancelBtn')?.addEventListener('click', () => {
            document.getElementById('adminModal').style.display = 'none';
        });
        document.getElementById('closeAdminModalBtn')?.addEventListener('click', () => {
            document.getElementById('adminModal').style.display = 'none';
        });
        document.getElementById('adminModal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                document.getElementById('adminModal').style.display = 'none';
            }
        });

        document.getElementById('searchBtn')?.addEventListener('click', function(e) {
            e.preventDefault();
            loadTransactions();
        });

        document.getElementById('resetBtn')?.addEventListener('click', function(e) {
            e.preventDefault();
            document.getElementById('filterGiver').value = '';
            document.getElementById('filterReceiver').value = '';
            document.getElementById('filterBranch').value = '';
            document.getElementById('filterAction').value = '';
            document.getElementById('filterStatus').value = '';
            document.getElementById('filterFrom').value = '';
            document.getElementById('filterTo').value = '';
            txPage = 1;
            loadTransactions();
        });

        document.getElementById('inventorySearchInput')?.addEventListener('input', () => {
            invPage = 1;
            applyInventoryFilters();
        });
        document.getElementById('inventoryResetFiltersBtn')?.addEventListener('click', () => {
            document.getElementById('inventorySearchInput').value = '';
            invPage = 1;
            applyInventoryFilters();
        });
        document.getElementById('inventoryPrevPageBtn')?.addEventListener('click', () => {
            if (invPage > 1) {
                invPage--;
                renderInventoryTable();
                updateInventoryPagination();
            }
        });
        document.getElementById('inventoryNextPageBtn')?.addEventListener('click', () => {
            const totalPages = Math.ceil(invTotal / invRows);
            if (invPage < totalPages) {
                invPage++;
                renderInventoryTable();
                updateInventoryPagination();
            }
        });
        document.getElementById('refreshInventoryBtn')?.addEventListener('click', loadInventory);
        document.getElementById('inventoryRowsPerPage')?.addEventListener('change', function() {
            invRows = parseInt(this.value);
            invPage = 1;
            applyInventoryFilters();
        });

        document.getElementById('manageKeysBtn')?.addEventListener('click', openKeyManageModal);
        document.getElementById('closeKeyManageModalBtn')?.addEventListener('click', () => {
            document.getElementById('keyManageModal').style.display = 'none';
        });
        document.getElementById('closeKeyManageFooterBtn')?.addEventListener('click', () => {
            document.getElementById('keyManageModal').style.display = 'none';
        });
        document.getElementById('keyManageModal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                document.getElementById('keyManageModal').style.display = 'none';
            }
        });

        document.getElementById('manageKeySearch')?.addEventListener('input', () => {
            manageKeyPage = 1;
            fetchManageKeys();
        });
        document.getElementById('resetManageKeyFilters')?.addEventListener('click', () => {
            document.getElementById('manageKeySearch').value = '';
            manageKeyPage = 1;
            fetchManageKeys();
        });
        document.getElementById('manageKeyPrevBtn')?.addEventListener('click', () => {
            if (manageKeyPage > 1) {
                manageKeyPage--;
                renderManageKeyTable();
                updateManageKeyPagination();
            }
        });
        document.getElementById('manageKeyNextBtn')?.addEventListener('click', () => {
            const totalPages = Math.ceil(manageKeyTotal / manageKeyRows);
            if (manageKeyPage < totalPages) {
                manageKeyPage++;
                renderManageKeyTable();
                updateManageKeyPagination();
            }
        });
        document.getElementById('addKeyFromManageBtn')?.addEventListener('click', () => {
            openKeyEditModal(null);
            document.getElementById('keyManageModal').style.display = 'none';
        });

        document.getElementById('closeKeyEditModalBtn')?.addEventListener('click', () => {
            document.getElementById('keyEditModal').style.display = 'none';
        });
        document.getElementById('cancelKeyEditBtn')?.addEventListener('click', () => {
            document.getElementById('keyEditModal').style.display = 'none';
        });
        document.getElementById('keyEditModal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                document.getElementById('keyEditModal').style.display = 'none';
            }
        });

        document.getElementById('saveKeyEditBtn')?.addEventListener('click', async function() {
            const id = document.getElementById('editKeyId').value;
            const code = document.getElementById('editKeyCode').value.trim();
            const brand = document.getElementById('editKeyBrand').value.trim();
            const ownerField = document.getElementById('editKeyOwner').value.trim();
            const totalQuantity = parseInt(document.getElementById('editKeySets').value) || 1;
            const dateOwned = document.getElementById('editKeyDateOwned').value;
            const remarks = document.getElementById('editKeyRemarks').value.trim();
            const is_lost = document.getElementById('editKeyLost').checked;

            if (!code || !brand) {
                showAlertModal('Code and brand are required.', 'error');
                return;
            }

            let sets = [];
            if (ownerField) {
                const owners = ownerField.split(',').map(s => s.trim()).filter(Boolean);
                const quantityPerOwner = Math.max(1, Math.floor(totalQuantity / owners.length));
                sets = owners.map((owner, index) => ({
                    owner_name: owner,
                    quantity: index === owners.length - 1 ? totalQuantity - (quantityPerOwner * (owners.length - 1)) : quantityPerOwner,
                    remarks: remarks || null
                }));
            }

            const payload = {
                code,
                brand,
                sets: sets,
                date_owned: dateOwned || null,
                remarks: remarks || null,
                is_lost
            };

            const method = id ? 'PUT' : 'POST';
            const url = id ? `/api/admin/keys/${id}` : '/api/admin/keys';

            try {
                const res = await authenticatedFetch(url, { method, body: JSON.stringify(payload) });
                const data = await res.json();
                if (res.ok) {
                    await logAuditEvent(id ? 'update_key' : 'create_key', 'key', data.id || id, {
                        key_code: code,
                        brand: brand
                    });
                    showAlertModal(id ? 'Key updated successfully.' : 'Key created successfully.', 'success');
                    document.getElementById('keyEditModal').style.display = 'none';
                    loadInventory();
                    if (document.getElementById('keyManageModal').style.display === 'flex') fetchManageKeys();
                } else {
                    showAlertModal(data.error || 'Save failed. Please try again.', 'error');
                }
            } catch (err) {
                showAlertModal(err.message || 'Network error. Please check your connection.', 'error');
            }
        });

        document.addEventListener('click', function(e) {
            const btn = e.target.closest('.btn-print');
            if (!btn) return;
            const section = btn.dataset.section;
            let containerId = '';
            switch (section) {
                case 'transactions': containerId = 'transactionsCard'; break;
                case 'requests': containerId = 'requestsCard'; break;
                case 'inventory': containerId = 'inventoryCard'; break;
                case 'audit': containerId = 'auditCard'; break;
                case 'users': containerId = 'usersCard'; break;
                case 'templates': containerId = 'templatesCard'; break;
                case 'settings': containerId = 'settingsCard'; break;
                default: return;
            }
            printSection(containerId);
        });

        document.getElementById('manageTemplatesBtn')?.addEventListener('click', openTemplateManageModal);
        document.getElementById('closeTemplateManageModalBtn')?.addEventListener('click', () => {
            document.getElementById('templateManageModal').style.display = 'none';
        });
        document.getElementById('closeTemplateManageFooterBtn')?.addEventListener('click', () => {
            document.getElementById('templateManageModal').style.display = 'none';
        });
        document.getElementById('templateManageModal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                document.getElementById('templateManageModal').style.display = 'none';
            }
        });

        document.getElementById('addTemplateFromManageBtn')?.addEventListener('click', function() {
            document.getElementById('editTemplateKey').value = '';
            document.getElementById('editTemplateKeyDisplay').value = '';
            document.getElementById('editTemplateKeyDisplay').disabled = false;
            document.getElementById('editTemplateKeyDisplay').placeholder = 'Enter a unique key (e.g., welcome)';
            document.getElementById('editTemplateSubject').value = '';
            document.getElementById('editTemplateBody').value = '';
            document.getElementById('editTemplateActive').checked = true;
            document.getElementById('templateEditModalTitle').textContent = 'Add New Template';
            document.getElementById('templateEditModal').style.display = 'flex';
        });

        document.getElementById('closeTemplateEditModalBtn')?.addEventListener('click', () => {
            document.getElementById('templateEditModal').style.display = 'none';
        });
        document.getElementById('cancelTemplateEditBtn')?.addEventListener('click', () => {
            document.getElementById('templateEditModal').style.display = 'none';
        });
        document.getElementById('templateEditModal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                document.getElementById('templateEditModal').style.display = 'none';
            }
        });

        document.getElementById('saveTemplateEditBtn')?.addEventListener('click', async function() {
            const key = document.getElementById('editTemplateKey').value.trim();
            const keyDisplay = document.getElementById('editTemplateKeyDisplay').value.trim();
            const subject = document.getElementById('editTemplateSubject').value.trim();
            const body_html = document.getElementById('editTemplateBody').value.trim();
            const is_active = document.getElementById('editTemplateActive').checked;
            const finalKey = key || keyDisplay;
            if (!finalKey || !subject || !body_html) {
                showAlertModal('Key, subject, and body are required.', 'error');
                return;
            }
            const isNew = !key;
            const url = isNew ? '/api/admin/email/templates' : `/api/admin/email/templates/${finalKey}`;
            const method = isNew ? 'POST' : 'PUT';
            try {
                const res = await authenticatedFetch(url, { method, body: JSON.stringify({ subject, body_html, is_active }) });
                if (res.ok) {
                    await logAuditEvent(isNew ? 'create_email_template' : 'update_email_template', 'email_template', finalKey, {
                        subject: subject,
                        is_active: is_active
                    });
                    showAlertModal(isNew ? 'Template created successfully.' : 'Template updated successfully.', 'success');
                    document.getElementById('templateEditModal').style.display = 'none';
                    loadTemplates();
                    if (document.getElementById('templateManageModal').style.display === 'flex') openTemplateManageModal();
                } else {
                    const data = await res.json();
                    showAlertModal(data.error || 'Save failed. Please try again.', 'error');
                }
            } catch (err) {
                showAlertModal(err.message || 'Network error. Please check your connection.', 'error');
            }
        });

        document.getElementById('saveSettingsBtn')?.addEventListener('click', async function() {
            const toggles = document.querySelectorAll('.setting-toggle');
            const updates = [];
            for (const toggle of toggles) {
                const key = toggle.dataset.key;
                const enabled = toggle.checked;
                const config = {};
                const configInputs = toggle.closest('.setting-control').querySelectorAll('[data-config]');
                for (const input of configInputs) {
                    const configKey = input.dataset.config;
                    if (input.type === 'checkbox') {
                        config[configKey] = input.checked;
                    } else {
                        if (configKey === 'reminder_days_before') {
                            const val = input.value.trim();
                            config[configKey] = val ? val.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n)) : [];
                        } else {
                            config[configKey] = input.value;
                        }
                    }
                }
                updates.push({ key, enabled, config });
            }
            try {
                for (const update of updates) {
                    await authenticatedFetch(`/api/admin/email/settings/${update.key}`, {
                        method: 'PUT',
                        body: JSON.stringify({ enabled: update.enabled, config: update.config })
                    });
                }
                await logAuditEvent('update_notification_settings', 'settings', 'all', {
                    updates: updates
                });
                showAlertModal('All settings saved successfully.', 'success');
                loadSettings();
            } catch (err) {
                showAlertModal(err.message || 'Failed to save settings. Please check your network.', 'error');
            }
        });

        document.getElementById('addAdminRecipientBtn')?.addEventListener('click', openAddAdminRecipientModal);
        document.getElementById('closeAddAdminRecipientModalBtn')?.addEventListener('click', () => {
            document.getElementById('addAdminRecipientModal').style.display = 'none';
        });
        document.getElementById('cancelAddAdminRecipientBtn')?.addEventListener('click', () => {
            document.getElementById('addAdminRecipientModal').style.display = 'none';
        });
        document.getElementById('addAdminRecipientModal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                document.getElementById('addAdminRecipientModal').style.display = 'none';
            }
        });

        document.getElementById('saveAdminRecipientBtn')?.addEventListener('click', async function() {
            const select = document.getElementById('adminRecipientSelect');
            const userId = parseInt(select.value);
            if (!userId) {
                showAlertModal('Please select an admin user.', 'error');
                return;
            }
            try {
                const res = await authenticatedFetch('/api/admin/admin-notification-recipients', {
                    method: 'POST',
                    body: JSON.stringify({ user_id: userId, enabled: true })
                });
                if (res.ok) {
                    await logAuditEvent('add_admin_recipient', 'admin_recipient', userId, {
                        user_id: userId
                    });
                    showAlertModal('Admin added to notification recipients.', 'success');
                    document.getElementById('addAdminRecipientModal').style.display = 'none';
                    loadAdminRecipients();
                } else {
                    const data = await res.json();
                    showAlertModal(data.error || 'Failed to add recipient.', 'error');
                }
            } catch (err) {
                showAlertModal(err.message || 'Network error.', 'error');
            }
        });

        document.getElementById('refreshLostKeysBtn')?.addEventListener('click', loadLostKeysManagement);

        document.getElementById('closeLostKeyDetailModalBtn')?.addEventListener('click', () => {
            document.getElementById('lostKeyDetailModal').style.display = 'none';
        });
        document.getElementById('closeLostKeyDetailFooterBtn')?.addEventListener('click', () => {
            document.getElementById('lostKeyDetailModal').style.display = 'none';
        });
        document.getElementById('lostKeyDetailModal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                document.getElementById('lostKeyDetailModal').style.display = 'none';
            }
        });

        document.getElementById('closeLostKeyEditModalBtn')?.addEventListener('click', () => {
            document.getElementById('lostKeyEditModal').style.display = 'none';
        });
        document.getElementById('cancelLostKeyEditBtn')?.addEventListener('click', () => {
            document.getElementById('lostKeyEditModal').style.display = 'none';
        });
        document.getElementById('lostKeyEditModal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                document.getElementById('lostKeyEditModal').style.display = 'none';
            }
        });

        document.getElementById('saveLostKeyEditBtn')?.addEventListener('click', async function() {
            const id = document.getElementById('editLostTransactionId').value;
            const reason = document.getElementById('editLostReason').value.trim();
            const lostAt = document.getElementById('editLostDate').value;
            const status = document.getElementById('editLostStatus').value;

            if (!reason) {
                showAlertModal('Reason for loss is required.', 'error');
                return;
            }

            try {
                const res = await authenticatedFetch(`/api/admin/lost-keys/${id}/update`, {
                    method: 'POST',
                    body: JSON.stringify({
                        reason: reason,
                        lost_at: lostAt || null,
                        status: status
                    })
                });
                if (res.ok) {
                    await logAuditEvent('update_lost_key', 'lost_key', id, {
                        reason: reason,
                        status: status
                    });
                    showAlertModal('Lost key updated successfully.', 'success');
                    document.getElementById('lostKeyEditModal').style.display = 'none';
                    loadLostKeysManagement();
                    loadLostKeys();
                } else {
                    const data = await res.json();
                    showAlertModal(data.error || 'Update failed.', 'error');
                }
            } catch (err) {
                showAlertModal(err.message || 'Network error.', 'error');
            }
        });

        document.getElementById('refreshAdminRecipientsBtn')?.addEventListener('click', loadAdminRecipients);
        document.getElementById('refreshAuditLogBtn')?.addEventListener('click', loadAuditLogs);

        document.getElementById('addRoleBtn')?.addEventListener('click', () => {
            document.getElementById('newRoleName').value = '';
            document.getElementById('addRoleModal').style.display = 'flex';
        });
        document.getElementById('closeAddRoleModalBtn')?.addEventListener('click', () => {
            document.getElementById('addRoleModal').style.display = 'none';
        });
        document.getElementById('cancelAddRoleBtn')?.addEventListener('click', () => {
            document.getElementById('addRoleModal').style.display = 'none';
        });
        document.getElementById('addRoleModal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                document.getElementById('addRoleModal').style.display = 'none';
            }
        });
        document.getElementById('confirmAddRoleBtn')?.addEventListener('click', () => {
            const name = document.getElementById('newRoleName').value.trim();
            if (!name) {
                showAlertModal('Please enter a role name.', 'error');
                return;
            }
            if (permissionsData.roleMappings[name]) {
                showAlertModal('Role already exists.', 'error');
                return;
            }
            permissionsData.roleMappings[name] = [];
            permissionsData.roles = Object.keys(permissionsData.roleMappings);
            renderPermissions();
            document.getElementById('addRoleModal').style.display = 'none';
            showAlertModal(`Role "${name}" added.`, 'success');
        });

        document.getElementById('savePermissionsBtn')?.addEventListener('click', async function() {
            const updates = {};
            document.querySelectorAll('.permission-checkbox').forEach(cb => {
                const role = cb.dataset.role;
                const permId = parseInt(cb.dataset.permId);
                if (!updates[role]) updates[role] = [];
                if (cb.checked) updates[role].push(permId);
            });
            try {
                for (const [roleName, permIds] of Object.entries(updates)) {
                    await authenticatedFetch('/api/permissions/roles', {
                        method: 'POST',
                        body: JSON.stringify({ role_name: roleName, permission_ids: permIds })
                    });
                }
                await logAuditEvent('update_permissions', 'permissions', 'all', {
                    updates: updates
                });
                showAlertModal('Permissions saved successfully.', 'success');
                await loadPermissions();
            } catch (err) {
                showAlertModal(err.message || 'Failed to save permissions. Please check your network.', 'error');
            }
        });

        document.getElementById('closeKeyDetailModalBtn')?.addEventListener('click', () => {
            document.getElementById('keyDetailModal').style.display = 'none';
        });
        document.getElementById('closeKeyDetailFooterBtn')?.addEventListener('click', () => {
            document.getElementById('keyDetailModal').style.display = 'none';
        });
        document.getElementById('keyDetailModal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                document.getElementById('keyDetailModal').style.display = 'none';
            }
        });

        document.getElementById('openUserManagementBtn')?.addEventListener('click', () => {
            document.getElementById('userManagementModal').style.display = 'flex';
            fetchManageUsers();
        });
        document.getElementById('closeUserManagementModalBtn')?.addEventListener('click', () => {
            document.getElementById('userManagementModal').style.display = 'none';
        });
        document.getElementById('userManagementModal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                document.getElementById('userManagementModal').style.display = 'none';
            }
        });
    }

    async function init() {
        const isAuthenticated = await checkAuth();
        if (isAuthenticated) {
            const loadingContainer = document.getElementById('loadingContainer');
            const adminContentWrapper = document.getElementById('adminContentWrapper');

            if (loadingContainer) {
                loadingContainer.style.display = 'none';
            }
            if (adminContentWrapper) {
                adminContentWrapper.style.display = 'block';
            }

            fetchCsrfToken();
            updateUserDisplay();
            initEventListeners();
            initUserManagement();

            await Promise.all([
                loadTransactions(),
                loadPendingRequests(),
                loadPendingReturns(),
                loadLostKeys(),
                loadAuditHealth(),
                loadPendingRegistrations(),
                checkEmailPermissions()
            ]);

            setInterval(() => {
                loadTransactions();
                loadPendingRequests();
                loadPendingReturns();
                loadLostKeys();
                loadAuditHealth();
            }, 30000);
        }
    }

    document.addEventListener('DOMContentLoaded', init);
})();