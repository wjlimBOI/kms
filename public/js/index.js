(function() {
    'use strict';

    let isRedirecting = false;

    if (!localStorage.getItem('kms_token') && !window.location.pathname.includes('/login')) {
        window.location.href = '/login';
        return;
    }

    let csrfToken = null;
    let csrfFetchPromise = null;
    let allKeys = [];
    let basket = [];
    let currentBrandFilter = 'all';
    let currentLoanFilter = 'all';
    let pollInterval = null;
    let activePopover = null;
    let notificationTimeout = null;
    let pendingLostTransaction = null;

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
        
        window.location.href = '/login?t=' + Date.now();
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

    function getUserEmail() {
        const user = getUser();
        return user?.email || '';
    }

    function getUserName() {
        const user = getUser();
        return user?.name || '';
    }

    function getRole() {
        const u = getUser();
        return u?.role || 'user';
    }

    function isAdmin() {
        return getRole() === 'admin';
    }

    function getInitials(name) {
        if (!name) return '?';
        const parts = name.trim().split(/\s+/);
        if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
        return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
    }

    function generateRequestId() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            var r = Math.random() * 16 | 0,
                v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : m === '>' ? '&gt;' : '');
    }

    function formatDate(isoString) {
        if (!isoString) return '—';
        const d = new Date(isoString);
        return d.toLocaleString('en-SG', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    function getDotColour(colour) {
        const map = {
            orange: '#F97316',
            red: '#EF4444',
            blue: '#3B82F6',
            purple: '#8B5CF6',
            pink: '#EC4899',
            yellow: '#EAB308',
            'tiffany blue': '#14B8A6',
            green: '#22C55E',
            black: '#1E293B',
            white: '#F8FAFC'
        };
        return map[colour?.toLowerCase()] || '#94A3B8';
    }

    function isLightColor(hexColor) {
        const hex = hexColor.replace('#', '');
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);
        return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
    }

    function getReturnStatus(plannedReturnISO) {
        if (!plannedReturnISO) return { text: 'No return date', urgencyClass: '' };
        const now = new Date(),
            due = new Date(plannedReturnISO),
            diff = due - now;
        if (diff < 0) {
            const days = Math.abs(Math.floor(diff / (1000 * 60 * 60 * 24)));
            return { text: `Overdue by ${days} day${days !== 1 ? 's' : ''}`, urgencyClass: 'return-overdue' };
        }
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        if (days > 1) return { text: `Due in ${days} days`, urgencyClass: '' };
        if (days === 1) return { text: 'Due tomorrow', urgencyClass: 'return-urgent' };
        const hours = Math.floor(diff / (1000 * 60 * 60));
        return { text: `Due in ${hours} hour${hours !== 1 ? 's' : ''}`, urgencyClass: 'return-urgent' };
    }

    function showToast(message, type = 'success') {
        let toastRoot = document.getElementById('toastRoot');
        if (!toastRoot) {
            toastRoot = document.createElement('div');
            toastRoot.id = 'toastRoot';
            document.body.appendChild(toastRoot);
        }
        const toast = document.createElement('div');
        toast.className = 'toast-notification';
        toast.textContent = message;
        if (type === 'error') toast.style.background = '#EF4444';
        else if (type === 'warning') toast.style.background = '#F59E0B';
        else toast.style.background = '#1E293B';
        toastRoot.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }

    function showNotification(title, message, type = 'success') {
        const modal = document.getElementById('notificationModal');
        if (!modal) return;
        const iconDiv = document.getElementById('notificationIcon');
        const titleSpan = document.getElementById('notificationTitle');
        const messageSpan = document.getElementById('notificationMessage');

        iconDiv.className = 'notification-icon ' + type;
        let iconSvg = '';
        if (type === 'success') {
            iconSvg = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />';
        } else if (type === 'warning') {
            iconSvg = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />';
        } else if (type === 'error') {
            iconSvg = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />';
        } else {
            iconSvg = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />';
        }
        iconDiv.innerHTML = `<svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">${iconSvg}</svg>`;
        titleSpan.innerText = title;
        messageSpan.innerText = message;
        modal.style.display = 'flex';
        if (notificationTimeout) clearTimeout(notificationTimeout);
        notificationTimeout = setTimeout(() => closeNotification(), 3000);
    }

    function closeNotification() {
        const modal = document.getElementById('notificationModal');
        if (modal) modal.style.display = 'none';
        if (notificationTimeout) clearTimeout(notificationTimeout);
    }

    function createPopover(borrower, returnDateISO) {
        const info = getReturnStatus(returnDateISO);
        const pop = document.createElement('div');
        pop.className = 'popover';
        pop.innerHTML = `<div><span class="font-semibold text-slate-800">${escapeHtml(borrower)}</span></div><hr class="my-2"><div class="text-slate-600">Expected return: <span class="${info.urgencyClass}">${info.text}</span></div>`;
        return pop;
    }

    function showPopover(target, borrower, returnDate) {
        if (activePopover) activePopover.remove();
        const pop = createPopover(borrower, returnDate);
        document.body.appendChild(pop);
        const rect = target.getBoundingClientRect();
        pop.style.top = `${rect.bottom + window.scrollY + 6}px`;
        pop.style.left = `${rect.left + window.scrollX + rect.width / 2 - 100}px`;
        pop.classList.add('show');
        activePopover = pop;
    }

    function hidePopover() {
        if (activePopover) {
            activePopover.remove();
            activePopover = null;
        }
    }

    async function authenticatedFetch(url, options = {}) {
        const token = getToken();
        if (!token) {
            if (!isRedirecting) {
                redirectToLogin();
            }
            throw new Error('No token');
        }

        let csrf = await getCsrfToken();
        if (!csrf) csrf = '';

        const headers = {
            'Authorization': `Bearer ${token}`,
            'X-CSRF-Token': csrf,
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'application/json',
            'X-Request-Id': generateRequestId(),
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
                throw new Error('Session expired');
            }

            return response;
        } catch (error) {
            if (error.name === 'TypeError' && error.message.includes('fetch')) {
                throw new Error('Network error. Please check your connection.');
            }
            throw error;
        }
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

            localStorage.setItem('kms_user', JSON.stringify(data.user));
            return true;
        } catch (error) {
            console.error('Auth check failed:', error);
            if (!isRedirecting) {
                redirectToLogin();
            }
            return false;
        }
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

    // ============================================================
    // FIX 1: BORROW TOGGLE BUTTONS - EVENT HANDLERS
    // ============================================================
    function initBorrowToggle() {
        const toggleBtns = document.querySelectorAll('.borrow-toggle-btn');
        const timeContainer = document.getElementById('borrowTimeContainer');
        const borrowDateHidden = document.getElementById('borrowDateHidden');
        const timePicker = document.getElementById('borrowTimePicker');
        const plannedReturn = document.getElementById('modalPlannedReturn');

        if (!toggleBtns.length) {
            console.warn('Borrow toggle buttons not found');
            return;
        }

        // Set default date
        const now = new Date();
        if (borrowDateHidden) {
            borrowDateHidden.value = now.toISOString();
        }
        if (plannedReturn) {
            const returnDate = new Date(now);
            returnDate.setDate(returnDate.getDate() + 7);
            plannedReturn.value = returnDate.toISOString().slice(0, 16);
        }

        toggleBtns.forEach(btn => {
            btn.addEventListener('click', function(e) {
                e.preventDefault();
                
                toggleBtns.forEach(b => b.classList.remove('active'));
                this.classList.add('active');

                const borrowType = this.dataset.borrowType;
                
                if (borrowType === 'now') {
                    const now = new Date();
                    if (borrowDateHidden) {
                        borrowDateHidden.value = now.toISOString();
                    }
                    if (timeContainer) {
                        timeContainer.style.display = 'none';
                    }
                    if (plannedReturn) {
                        const returnDate = new Date(now);
                        returnDate.setDate(returnDate.getDate() + 7);
                        plannedReturn.value = returnDate.toISOString().slice(0, 16);
                    }
                } else if (borrowType === 'today') {
                    if (timeContainer) {
                        timeContainer.style.display = 'block';
                    }
                    if (timePicker) {
                        const now = new Date();
                        const hours = String(now.getHours()).padStart(2, '0');
                        const minutes = String(now.getMinutes()).padStart(2, '0');
                        timePicker.value = `${hours}:${minutes}`;
                        updateBorrowDateTime();
                    }
                }
            });
        });

        if (timePicker) {
            timePicker.addEventListener('change', updateBorrowDateTime);
            timePicker.addEventListener('input', updateBorrowDateTime);
        }

        function updateBorrowDateTime() {
            const timePicker = document.getElementById('borrowTimePicker');
            const borrowDateHidden = document.getElementById('borrowDateHidden');
            const plannedReturn = document.getElementById('modalPlannedReturn');
            
            if (timePicker && borrowDateHidden) {
                const now = new Date();
                const [hours, minutes] = timePicker.value.split(':').map(Number);
                now.setHours(hours || 0, minutes || 0, 0, 0);
                borrowDateHidden.value = now.toISOString();
                
                if (plannedReturn) {
                    const returnDate = new Date(now);
                    returnDate.setDate(returnDate.getDate() + 7);
                    plannedReturn.value = returnDate.toISOString().slice(0, 16);
                }
            }
        }
    }

    function initEventListeners() {
        // Logout
        document.getElementById('logoutBtn')?.addEventListener('click', handleLogout);
        document.getElementById('mobileLogoutBtn')?.addEventListener('click', handleLogout);

        // Mobile menu
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

        // Profile
        document.getElementById('mobileProfileBtn')?.addEventListener('click', function() {
            const mobileMenu = document.getElementById('mobileMenu');
            if (mobileMenu) mobileMenu.classList.remove('open');

            const modal = document.getElementById('profileModal');
            if (modal) {
                const user = getUser();
                if (user) {
                    document.getElementById('profileName').value = user.name || '';
                    document.getElementById('profileEmail').value = user.email || '';
                }
                document.getElementById('profileCurrentPassword').value = '';
                document.getElementById('profileNewPassword').value = '';
                document.getElementById('profileError').style.display = 'none';
                document.getElementById('profileSuccess').style.display = 'none';
                modal.style.display = 'flex';
            }
        });

        document.getElementById('myProfileBtn')?.addEventListener('click', function() {
            const modal = document.getElementById('profileModal');
            if (modal) {
                const user = getUser();
                if (user) {
                    document.getElementById('profileName').value = user.name || '';
                    document.getElementById('profileEmail').value = user.email || '';
                }
                document.getElementById('profileCurrentPassword').value = '';
                document.getElementById('profileNewPassword').value = '';
                document.getElementById('profileError').style.display = 'none';
                document.getElementById('profileSuccess').style.display = 'none';
                modal.style.display = 'flex';
            }
        });

        document.getElementById('closeProfileModalBtn')?.addEventListener('click', () => {
            document.getElementById('profileModal').style.display = 'none';
        });
        document.getElementById('cancelProfileBtn')?.addEventListener('click', () => {
            document.getElementById('profileModal').style.display = 'none';
        });
        document.getElementById('profileModal')?.addEventListener('click', (e) => {
            if (e.target === document.getElementById('profileModal')) {
                document.getElementById('profileModal').style.display = 'none';
            }
        });

        document.getElementById('saveProfileBtn')?.addEventListener('click', async () => {
            const name = document.getElementById('profileName').value.trim();
            const email = document.getElementById('profileEmail').value.trim();
            const currentPassword = document.getElementById('profileCurrentPassword').value;
            const newPassword = document.getElementById('profileNewPassword').value;
            const errorDiv = document.getElementById('profileError');
            const successDiv = document.getElementById('profileSuccess');

            errorDiv.style.display = 'none';
            successDiv.style.display = 'none';

            if (!name || !email || !email.includes('@') || !email.includes('.')) {
                errorDiv.textContent = !name || !email ? 'Name and email are required.' : 'Please enter a valid email address.';
                errorDiv.style.display = 'block';
                return;
            }

            const btn = document.getElementById('saveProfileBtn');
            btn.disabled = true;
            btn.textContent = 'Saving...';

            try {
                const payload = { name, email };
                if (newPassword) {
                    if (!currentPassword) {
                        errorDiv.textContent = 'Current password is required to change password.';
                        errorDiv.style.display = 'block';
                        btn.disabled = false;
                        btn.textContent = 'Save Changes';
                        return;
                    }
                    payload.current_password = currentPassword;
                    payload.new_password = newPassword;
                }

                const res = await authenticatedFetch('/api/user/profile', {
                    method: 'PUT',
                    body: JSON.stringify(payload)
                });
                const data = await res.json();

                if (res.ok) {
                    const user = getUser();
                    if (user) {
                        user.name = name;
                        user.email = email;
                        localStorage.setItem('kms_user', JSON.stringify(user));
                    }

                    successDiv.textContent = 'Profile updated successfully!';
                    successDiv.style.display = 'block';
                    document.getElementById('profileCurrentPassword').value = '';
                    document.getElementById('profileNewPassword').value = '';

                    setTimeout(() => {
                        document.getElementById('profileModal').style.display = 'none';
                    }, 2000);
                } else {
                    errorDiv.textContent = data.error || 'Failed to update profile.';
                    errorDiv.style.display = 'block';
                }
            } catch (err) {
                errorDiv.textContent = err.message || 'Network error. Please try again.';
                errorDiv.style.display = 'block';
            } finally {
                btn.disabled = false;
                btn.textContent = 'Save Changes';
            }
        });

        // Notification
        document.getElementById('closeNotificationBtn')?.addEventListener('click', closeNotification);
        document.getElementById('notificationModal')?.addEventListener('click', (e) => {
            if (e.target === document.getElementById('notificationModal')) closeNotification();
        });

        document.addEventListener('click', (e) => {
            if (activePopover && !activePopover.contains(e.target) && !e.target.closest('.key-card .badge')) {
                hidePopover();
            }
        });

        // Basket
        document.getElementById('clearBasketBtn')?.addEventListener('click', () => {
            if (basket.length) {
                basket = [];
                renderBasket();
                showToast('Basket cleared', 'info');
            }
        });

        // Request modal
        document.getElementById('submitRequestBtn')?.addEventListener('click', openRequestModal);
        document.getElementById('closeModalBtn')?.addEventListener('click', closeRequestModal);
        document.getElementById('cancelModalBtn')?.addEventListener('click', closeRequestModal);
        document.getElementById('confirmSubmitBtn')?.addEventListener('click', submitRequest);
        document.getElementById('consentCheckbox')?.addEventListener('change', () => {
            const confirmBtn = document.getElementById('confirmSubmitBtn');
            if (confirmBtn) {
                confirmBtn.disabled = !document.getElementById('consentCheckbox').checked;
            }
        });

        // Search
        const searchInput = document.getElementById('globalSearch');
        searchInput?.addEventListener('input', filterKeysBySearch);

        // Initialize borrow toggle buttons
        initBorrowToggle();
    }

    async function fetchKeys() {
        try {
            const res = await authenticatedFetch('/api/keys?_=' + Date.now(), {
                cache: 'no-store',
                headers: { 'Cache-Control': 'no-cache' }
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            allKeys = await res.json();
            renderFilteredGrid();
            const indicator = document.getElementById('onlineIndicator');
            const status = document.getElementById('onlineStatus');
            if (indicator) {
                indicator.classList.remove('bg-red-500');
                indicator.classList.add('online');
            }
            if (status) status.textContent = 'Online';
        } catch (e) {
            console.error('Fetch keys error:', e);
            const indicator = document.getElementById('onlineIndicator');
            const status = document.getElementById('onlineStatus');
            if (indicator) {
                indicator.classList.remove('online');
                indicator.classList.add('bg-red-500');
            }
            if (status) status.textContent = 'Offline';
            if (!allKeys.length) {
                const grid = document.getElementById('keysGrid');
                if (grid) {
                    grid.innerHTML = '<div class="col-span-full text-center py-12 text-slate-400">Error loading keys. Please refresh.</div>';
                }
                showToast('Failed to load keys', 'error');
            }
        }
    }

    // ============================================================
    // FIX 2: REMOVED BORROW BUTTON FROM KEY CARDS
    // ============================================================
    function renderFilteredGrid() {
        let filtered = [...allKeys];
        if (currentBrandFilter !== 'all') filtered = filtered.filter(k => k.brand === currentBrandFilter);
        if (currentLoanFilter === 'available') filtered = filtered.filter(k => k.available === true);
        else if (currentLoanFilter === 'loaned') filtered = filtered.filter(k => k.available === false);

        const container = document.getElementById('keysGrid');
        const emptyState = document.getElementById('emptySearchState');

        if (!filtered.length) {
            if (container) {
                container.innerHTML = '<div class="col-span-full text-center py-12 text-slate-400">No keys match current filters.</div>';
            }
            if (emptyState) emptyState.classList.add('hidden');
            return;
        }

        let html = '';
        filtered.forEach(key => {
            const dotColor = getDotColour(key.colour);
            let statusBadge = '',
                isAvailable = false;
            
            const keyStatus = key.status || (key.is_lost ? 'lost' : 'available');

            if (keyStatus === 'lost') {
                statusBadge = `<span class="key-status" style="background:rgba(220,38,38,0.85);">Lost</span>`;
            } else if (keyStatus === 'unavailable') {
                statusBadge = `<span class="key-status" style="background:rgba(100,116,139,0.85);">Unavailable</span>`;
            } else if (key.pending) {
                statusBadge = `<span class="key-status" style="background:rgba(245,158,11,0.85);">Pending</span>`;
            } else if (key.pending_return) {
                statusBadge = `<span class="key-status" style="background:rgba(245,158,11,0.85);">Returning</span>`;
            } else if (key.available) {
                statusBadge = `<span class="key-status" style="background:rgba(16,185,129,0.85);">Available</span>`;
                isAvailable = true;
            } else {
                statusBadge = `<span class="key-status" style="background:rgba(100,116,139,0.85);">On Loan</span>`;
            }

            const isLight = isLightColor(dotColor);
            const textColor = isLight ? '#0f172a' : '#ffffff';
            const shadow = isLight ? '0 1px 4px rgba(0,0,0,0.1)' : '0 1px 4px rgba(0,0,0,0.3)';

            // FIX: Removed the borrow-btn - clicking the card handles adding to basket
            html += `
                <div class="key-card" style="background-color:${dotColor}; color:${textColor}; text-shadow:${shadow};"
                     data-id="${key.id}" data-code="${escapeHtml(key.code)}" data-brand="${escapeHtml(key.brand)}"
                     data-available="${key.available}" data-status="${keyStatus}"
                     data-borrower-name="${escapeHtml(key.borrower_name || '')}" 
                     data-borrower-email="${escapeHtml(key.borrower_email || '')}" 
                     data-return-date="${key.planned_return || ''}">
                    <div class="key-code">${escapeHtml(key.code)}</div>
                    <div class="key-brand">${escapeHtml(key.brand)}</div>
                    ${statusBadge}
                </div>
            `;
        });
        if (container) {
            container.innerHTML = html;
        }

        // FIX: Click on the entire card adds to basket
        document.querySelectorAll('.key-card').forEach(card => {
            card.addEventListener('click', function(e) {
                // Don't trigger if clicking on a status badge or popover
                if (e.target.closest('.key-status') || e.target.closest('.popover')) {
                    return;
                }
                const keyId = parseInt(this.dataset.id);
                const key = allKeys.find(k => k.id === keyId);
                if (key && key.available && key.status !== 'lost' && key.status !== 'unavailable') {
                    addToBasket(key);
                } else {
                    // Show a toast explaining why it can't be borrowed
                    if (key) {
                        const status = key.status || (key.is_lost ? 'lost' : 'unavailable');
                        if (status === 'lost') {
                            showToast(`${key.code} is marked as lost`, 'warning');
                        } else if (status === 'unavailable') {
                            showToast(`${key.code} is unavailable`, 'warning');
                        } else {
                            showToast(`${key.code} is not available for borrowing`, 'warning');
                        }
                    }
                }
            });
        });

        // Popover on status badge for loaned keys
        document.querySelectorAll('.key-card .key-status').forEach(badge => {
            const card = badge.closest('.key-card');
            if (!card) return;
            const isAvailable = card.getAttribute('data-available') === 'true';
            if (isAvailable) return;
            
            badge.addEventListener('click', function(e) {
                e.stopPropagation();
                const borrowerName = card.getAttribute('data-borrower-name');
                const returnDate = card.getAttribute('data-return-date');
                if (borrowerName && returnDate && borrowerName !== '') {
                    showPopover(this, borrowerName, returnDate);
                }
            });
        });

        filterKeysBySearch();
    }

    function filterKeysBySearch() {
        const searchInput = document.getElementById('globalSearch');
        const emptyState = document.getElementById('emptySearchState');
        const query = searchInput?.value.trim().toLowerCase() || '';
        const cards = document.querySelectorAll('#keysGrid .key-card');
        let visibleCount = 0;
        cards.forEach(card => {
            const keyCode = (card.getAttribute('data-code') || '').toLowerCase();
            const borrowerEmail = (card.getAttribute('data-borrower-email') || '').toLowerCase();
            const matches = query === '' || keyCode.includes(query) || borrowerEmail.includes(query);
            if (matches) {
                card.classList.remove('filter-hidden');
                visibleCount++;
            } else {
                card.classList.add('filter-hidden');
            }
        });
        if (emptyState) {
            if (visibleCount === 0 && query !== '') emptyState.classList.remove('hidden');
            else emptyState.classList.add('hidden');
        }
    }

    function addToBasket(key) {
        if (!key.available || key.status === 'lost' || key.status === 'unavailable') {
            showToast(`${key.code} is not available`, 'warning');
            return;
        }
        if (basket.some(k => k.id === key.id)) {
            showToast(`${key.code} already in basket`, 'warning');
            return;
        }
        basket.push({ id: key.id, code: key.code, brand: key.brand });
        renderBasket();
        const card = document.querySelector(`.key-card[data-id='${key.id}']`);
        if (card) {
            card.classList.add('ring-2', 'ring-blue-400', 'ring-offset-1');
            setTimeout(() => card.classList.remove('ring-2', 'ring-blue-400', 'ring-offset-1'), 400);
        }
        showToast(`${key.code} added to basket`, 'success');
    }

    function removeFromBasket(keyId) {
        const removed = basket.find(k => k.id === keyId);
        if (removed) {
            basket = basket.filter(k => k.id !== keyId);
            renderBasket();
            showToast(`${removed.code} removed`, 'info');
        }
    }

    function renderBasket() {
        const container = document.getElementById('basketItemsContainer');
        const countSpan = document.getElementById('basketCountBadge');
        const totalSpan = document.getElementById('totalQuantity');
        const submitBtn = document.getElementById('submitRequestBtn');
        const total = basket.length;

        if (countSpan) countSpan.innerText = total;
        if (totalSpan) totalSpan.innerText = total;

        if (total === 0) {
            if (container) {
                container.innerHTML = `<div class="p-6 text-center text-slate-400 text-sm">No keys selected. Click on available keys to add.</div>`;
            }
            if (submitBtn) submitBtn.disabled = true;
            return;
        }

        if (submitBtn) submitBtn.disabled = false;
        let html = `<div class="divide-y divide-gray-100">`;
        basket.forEach(item => {
            html += `
                <div class="flex justify-between items-center p-3 hover:bg-slate-50 transition">
                    <div>
                        <span class="font-medium text-slate-800">${escapeHtml(item.code)}</span>
                        <span class="text-xs text-slate-500 ml-1.5">${escapeHtml(item.brand)}</span>
                    </div>
                    <button class="remove-item text-rose-500 hover:text-rose-700 transition text-sm font-medium" data-id="${item.id}">Remove</button>
                </div>
            `;
        });
        html += `</div>`;
        if (container) {
            container.innerHTML = html;
        }

        document.querySelectorAll('.remove-item').forEach(btn => {
            btn.addEventListener('click', () => {
                removeFromBasket(parseInt(btn.dataset.id));
            });
        });
    }

    // ============================================================
    // FIX 3: REQUEST MODAL - AUTO-POPULATE USER INFO
    // ============================================================
    function openRequestModal() {
        if (!basket.length) {
            showNotification('Empty Basket', 'Please add at least one key to your basket before submitting a request.', 'warning');
            return;
        }

        const listContainer = document.getElementById('modalSelectedKeysList');
        if (listContainer) {
            listContainer.innerHTML = '<ul class="list-disc list-inside">' + basket.map(i => `<li>${escapeHtml(i.code)} (${escapeHtml(i.brand)})</li>`).join('') + '</ul>';
        }

        // FIX: Populate user info from logged-in user
        const user = getUser();
        const nameDisplay = document.getElementById('modalUserDisplayName');
        const emailDisplay = document.getElementById('modalUserDisplayEmail');
        
        if (nameDisplay) {
            nameDisplay.textContent = user?.name || 'Not logged in';
        }
        if (emailDisplay) {
            emailDisplay.textContent = user?.email || 'Not logged in';
        }

        document.getElementById('modalReason').value = '';
        
        // Set default return date to 7 days from now
        const plannedReturn = document.getElementById('modalPlannedReturn');
        if (plannedReturn) {
            const now = new Date();
            const returnDate = new Date(now);
            returnDate.setDate(returnDate.getDate() + 7);
            plannedReturn.value = returnDate.toISOString().slice(0, 16);
        }
        
        const errorDiv = document.getElementById('modalError');
        if (errorDiv) errorDiv.classList.add('hidden');
        
        document.getElementById('consentCheckbox').checked = false;
        document.getElementById('confirmSubmitBtn').disabled = true;
        document.getElementById('requestModal').style.display = 'flex';
    }

    function closeRequestModal() {
        document.getElementById('requestModal').style.display = 'none';
    }

    // ============================================================
    // FIX 4: SUBMIT REQUEST - USE LOGGED-IN USER INFO
    // ============================================================
    async function submitRequest() {
        const user = getUser();
        const name = user?.name || '';
        const email = user?.email || '';
        const reason = document.getElementById('modalReason').value.trim();
        const planned = document.getElementById('modalPlannedReturn').value;
        const modalError = document.getElementById('modalError');
        const consentCheckbox = document.getElementById('consentCheckbox');
        const confirmBtn = document.getElementById('confirmSubmitBtn');

        if (!name || !email || !email.includes('@') || !planned) {
            if (modalError) {
                modalError.textContent = 'Please ensure your profile is complete with name and email, and a return date is selected.';
                modalError.classList.remove('hidden');
            }
            return;
        }
        if (!consentCheckbox.checked) {
            if (modalError) {
                modalError.textContent = 'You must accept the Key Replacement Fee disclaimer.';
                modalError.classList.remove('hidden');
            }
            return;
        }
        if (modalError) modalError.classList.add('hidden');
        if (confirmBtn) {
            confirmBtn.disabled = true;
            confirmBtn.textContent = 'Submitting...';
        }

        try {
            const res = await authenticatedFetch('/api/requests/submit', {
                method: 'POST',
                body: JSON.stringify({
                    requester_name: name,
                    requester_email: email,
                    items: basket.map(i => ({ key_id: i.id, quantity: 1 })),
                    reason: reason || null,
                    planned_return: planned
                })
            });
            const data = await res.json();
            if (res.ok) {
                showNotification('Request Submitted', 'Your key request has been submitted successfully. Awaiting admin approval.', 'success');
                basket = [];
                renderBasket();
                fetchKeys();
                closeRequestModal();
            } else {
                throw new Error(data.error || 'Submission failed');
            }
        } catch (e) {
            showNotification('Submission Failed', e.message, 'error');
            if (modalError) {
                modalError.textContent = 'Submission failed. Please try again.';
                modalError.classList.remove('hidden');
            }
        } finally {
            if (confirmBtn) {
                confirmBtn.disabled = false;
                confirmBtn.textContent = 'Submit request';
            }
        }
    }

    function initFilters() {
        const basketSidebar = document.getElementById('basketSidebar');

        function updateBasketVisibility(filterValue) {
            if (basketSidebar) {
                const shouldHide = (filterValue === 'loaned');
                if (shouldHide) basketSidebar.classList.add('hide-basket');
                else basketSidebar.classList.remove('hide-basket');
            }
        }

        document.querySelectorAll('[data-filter]').forEach(btn => {
            btn.addEventListener('click', () => {
                const filterValue = btn.getAttribute('data-filter');
                currentLoanFilter = filterValue;
                document.querySelectorAll('[data-filter]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                renderFilteredGrid();
                updateBasketVisibility(filterValue);
            });
        });

        document.querySelectorAll('.brand-pill').forEach(btn => {
            btn.addEventListener('click', () => {
                currentBrandFilter = btn.getAttribute('data-brand');
                document.querySelectorAll('.brand-pill').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                renderFilteredGrid();
            });
        });

        updateBasketVisibility(currentLoanFilter);
    }

    function initReturnDropdown() {
        const returnDropdownBtn = document.getElementById('returnDropdownBtn');
        const returnDropdownMenu = document.getElementById('returnDropdownMenu');
        const returnDropdownChevron = document.getElementById('returnDropdownChevron');

        if (returnDropdownBtn) {
            returnDropdownBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (returnDropdownMenu) {
                    returnDropdownMenu.classList.toggle('hidden');
                }
                if (returnDropdownChevron) {
                    const isHidden = returnDropdownMenu?.classList.contains('hidden');
                    returnDropdownChevron.style.transform = isHidden ? 'rotate(0deg)' : 'rotate(180deg)';
                }
            });
        }

        document.addEventListener('click', (e) => {
            const container = document.getElementById('returnDropdownContainer');
            if (container && !container.contains(e.target)) {
                if (returnDropdownMenu) {
                    returnDropdownMenu.classList.add('hidden');
                }
                if (returnDropdownChevron) {
                    returnDropdownChevron.style.transform = 'rotate(0deg)';
                }
            }
        });
    }

    // ============================================================
    // FIX 5: RETURN MODAL - PROPER STEP MANAGEMENT
    // ============================================================
    function initReturnModal() {
        const returnModal = document.getElementById('returnModal');
        const step1 = document.getElementById('returnStep1');
        const step2 = document.getElementById('returnStep2');
        const step3 = document.getElementById('returnStep3');
        const activeLoansContainer = document.getElementById('activeLoansListContainer');
        const submitReturnBtn = document.getElementById('submitReturnConfirmBtn');
        const selectAllBtn = document.getElementById('selectAllReturnBtn');
        const returnSelectionError = document.getElementById('returnSelectionError');
        const fetchLoansBtn = document.getElementById('fetchLoansByEmailBtn');

        function closeReturnModal() {
            if (returnModal) returnModal.style.display = 'none';
            if (step1) step1.style.display = 'block';
            if (step2) step2.style.display = 'none';
            if (step3) step3.style.display = 'none';
            if (activeLoansContainer) activeLoansContainer.innerHTML = '';
        }

        document.getElementById('returnNowBtn')?.addEventListener('click', () => {
            const menu = document.getElementById('returnDropdownMenu');
            const chevron = document.getElementById('returnDropdownChevron');
            if (menu) menu.classList.add('hidden');
            if (chevron) chevron.style.transform = 'rotate(0deg)';
            
            if (returnModal) returnModal.style.display = 'flex';
            if (step1) step1.style.display = 'none';
            if (step2) step2.style.display = 'block';
            if (step3) step3.style.display = 'none';
            
            autoLoadUserLoans();
        });

        fetchLoansBtn?.addEventListener('click', autoLoadUserLoans);

        document.getElementById('closeReturnModalBtn')?.addEventListener('click', closeReturnModal);
        document.getElementById('closeReturnSuccessBtn')?.addEventListener('click', closeReturnModal);
        returnModal?.addEventListener('click', (e) => {
            if (e.target === returnModal) closeReturnModal();
        });

        async function autoLoadUserLoans() {
            const email = getUserEmail();
            if (!email) {
                if (activeLoansContainer) {
                    activeLoansContainer.innerHTML = `<div class="p-6 text-center text-amber-600 bg-amber-50 rounded-xl"><p class="font-medium">No email found in your profile.</p><p class="text-sm mt-1">Please update your profile with a valid email address.</p></div>`;
                }
                return;
            }

            if (activeLoansContainer) {
                activeLoansContainer.innerHTML = '<div class="text-center py-4"><div class="spinner"></div> Loading your loans...</div>';
            }

            try {
                const response = await authenticatedFetch(`/api/return/active-loans?borrower_email=${encodeURIComponent(email)}&_=${Date.now()}`, {
                    cache: 'no-store',
                    headers: { 'Cache-Control': 'no-cache' }
                });

                if (response.ok) {
                    const data = await response.json();
                    if (!data || data.length === 0) {
                        if (activeLoansContainer) {
                            activeLoansContainer.innerHTML = `<div class="p-6 text-center text-slate-500 bg-gray-50 rounded-xl"><svg class="w-10 h-10 mx-auto mb-2 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" /></svg><p class="font-medium">No active key loans found.</p><p class="text-sm mt-1">You don't have any borrowed keys at the moment.</p></div>`;
                        }
                        const step2Header = document.querySelector('#returnStep2 .flex.justify-between.items-center');
                        if (step2Header) step2Header.style.display = 'none';
                        if (submitReturnBtn) submitReturnBtn.style.display = 'none';
                        return;
                    }

                    let loansHtml = '';
                    data.forEach(loan => {
                        loansHtml += `
                            <label class="flex items-start gap-3 p-3 border border-gray-200 rounded-xl cursor-pointer hover:bg-slate-50 transition">
                                <input type="checkbox" class="loan-return-checkbox mt-0.5" data-loan-id="${loan.id}" data-key-id="${loan.key_id}" />
                                <div class="flex-1">
                                    <div class="font-medium text-slate-800">${escapeHtml(loan.key_code)} (${escapeHtml(loan.brand)})</div>
                                    <div class="text-xs text-slate-500">Borrowed: ${formatDate(loan.borrowed_at)} · Due: ${formatDate(loan.planned_return)}</div>
                                </div>
                            </label>
                        `;
                    });
                    if (activeLoansContainer) {
                        activeLoansContainer.innerHTML = loansHtml;
                    }
                    if (step1) step1.style.display = 'none';
                    if (step2) step2.style.display = 'block';
                    if (step3) step3.style.display = 'none';

                    const checkboxes = () => document.querySelectorAll('.loan-return-checkbox');
                    const updateSelectAll = () => {
                        const all = checkboxes();
                        const allChecked = all.length > 0 && Array.from(all).every(cb => cb.checked);
                        if (selectAllBtn) {
                            selectAllBtn.innerHTML = allChecked ? 'Deselect all' : 'Select all';
                        }
                    };
                    checkboxes().forEach(cb => cb.addEventListener('change', updateSelectAll));

                    if (selectAllBtn) {
                        selectAllBtn.onclick = () => {
                            const all = checkboxes();
                            const someUnchecked = Array.from(all).some(cb => !cb.checked);
                            all.forEach(cb => cb.checked = someUnchecked);
                            updateSelectAll();
                        };
                    }
                    updateSelectAll();

                    const step2Header = document.querySelector('#returnStep2 .flex.justify-between.items-center');
                    if (step2Header) step2Header.style.display = 'flex';
                    if (submitReturnBtn) submitReturnBtn.style.display = 'block';
                } else {
                    throw new Error(`Server returned status: ${response.status}`);
                }
            } catch (err) {
                console.error('Return loans error:', err);
                showToast('Error fetching your active loans. Please try again.', 'error');
                if (activeLoansContainer) {
                    activeLoansContainer.innerHTML = `<div class="p-6 text-center text-rose-600 bg-rose-50 rounded-xl"><p class="font-medium">Unable to load your loans.</p><p class="text-sm mt-1">Please refresh the page or contact support.</p></div>`;
                }
            }
        }

        submitReturnBtn?.addEventListener('click', async () => {
            const selected = Array.from(document.querySelectorAll('.loan-return-checkbox:checked'));
            if (!selected.length) {
                if (returnSelectionError) {
                    returnSelectionError.innerText = 'Please select at least one key to return.';
                    returnSelectionError.classList.remove('hidden');
                }
                return;
            }
            if (returnSelectionError) returnSelectionError.classList.add('hidden');

            const loanIds = selected.map(cb => parseInt(cb.dataset.loanId));
            const selectedKeyIds = selected.map(cb => parseInt(cb.dataset.keyId));

            if (submitReturnBtn) {
                submitReturnBtn.disabled = true;
                submitReturnBtn.innerHTML = '<div class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div> Processing...';
            }

            const email = getUserEmail();

            try {
                const res = await authenticatedFetch('/api/return/request', {
                    method: 'POST',
                    body: JSON.stringify({ borrower_email: email, loan_ids: loanIds })
                });
                const data = await res.json();

                if (res.ok) {
                    allKeys = allKeys.map(key => {
                        if (selectedKeyIds.includes(key.id)) {
                            return { ...key, pending_return: true, available: false };
                        }
                        return key;
                    });
                    renderFilteredGrid();

                    showNotification('Return Request Submitted', 'Your return request has been submitted. Please hand the keys to the administrator for verification.', 'success');
                    if (step2) step2.style.display = 'none';
                    if (step3) step3.style.display = 'block';
                } else {
                    throw new Error(data.error || 'Return submission failed');
                }
            } catch (err) {
                console.error('Return submission error:', err);
                showNotification('Return Submission Failed', err.message, 'error');
                if (returnSelectionError) {
                    returnSelectionError.innerText = err.message;
                    returnSelectionError.classList.remove('hidden');
                }
            } finally {
                if (submitReturnBtn) {
                    submitReturnBtn.disabled = false;
                    submitReturnBtn.innerHTML = 'Submit return request →';
                }
            }
        });
    }

    // ============================================================
    // FIX 6: REPORT LOST - PROPER SCOPE
    // ============================================================
    function initReportLost() {
        const reportLostModal = document.getElementById('reportLostModal');
        const reportLostKeysContainer = document.getElementById('reportLostKeysListContainer');

        function closeReportLostModal() {
            if (reportLostModal) reportLostModal.style.display = 'none';
        }

        document.getElementById('reportLostKeyBtn')?.addEventListener('click', () => {
            const menu = document.getElementById('returnDropdownMenu');
            const chevron = document.getElementById('returnDropdownChevron');
            if (menu) menu.classList.add('hidden');
            if (chevron) chevron.style.transform = 'rotate(0deg)';
            
            if (reportLostModal) reportLostModal.style.display = 'flex';
            if (window.autoLoadLostKeys) {
                window.autoLoadLostKeys();
            }
        });

        document.getElementById('closeReportLostModalBtn')?.addEventListener('click', closeReportLostModal);
        reportLostModal?.addEventListener('click', (e) => {
            if (e.target === reportLostModal) closeReportLostModal();
        });

        window.autoLoadLostKeys = async function() {
            const email = getUserEmail();
            if (!email) {
                if (reportLostKeysContainer) {
                    reportLostKeysContainer.innerHTML = `<div class="text-center py-8 text-amber-600">No email found in your profile. Please update your profile.</div>`;
                }
                return;
            }

            if (reportLostKeysContainer) {
                reportLostKeysContainer.innerHTML = '<div class="text-center py-8"><div class="spinner"></div> Loading your borrowed keys...</div>';
            }

            try {
                const res = await authenticatedFetch(`/api/user/active-borrows?email=${encodeURIComponent(email)}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const borrows = await res.json();

                if (!borrows.length) {
                    if (reportLostKeysContainer) {
                        reportLostKeysContainer.innerHTML = '<div class="text-center py-8 text-slate-400">You don\'t have any active borrowed keys.</div>';
                    }
                    return;
                }

                let html = '';
                for (const b of borrows) {
                    html += `
                        <div class="border border-gray-200 rounded-xl p-3 flex justify-between items-center">
                            <div>
                                <div class="font-medium text-slate-800">${escapeHtml(b.key_code)} (${escapeHtml(b.brand)})</div>
                                <div class="text-xs text-slate-500">Borrowed: ${formatDate(b.borrowed_at)} · Due: ${formatDate(b.planned_return)}</div>
                            </div>
                            <button class="reportLostFromListBtn bg-rose-600 hover:bg-rose-700 text-white text-xs px-3 py-1.5 rounded-full transition" data-transaction-id="${b.id}" data-key-code="${escapeHtml(b.key_code)}">Report Lost</button>
                        </div>
                    `;
                }
                if (reportLostKeysContainer) {
                    reportLostKeysContainer.innerHTML = html;
                }

                document.querySelectorAll('.reportLostFromListBtn').forEach(btn => {
                    btn.addEventListener('click', () => {
                        pendingLostTransaction = { id: parseInt(btn.dataset.transactionId), code: btn.dataset.keyCode };
                        const modal = document.getElementById('confirmLostModal');
                        if (modal) {
                            document.getElementById('confirmLostMessage').innerHTML = 'Are you sure you want to report this key as lost? A Key Replacement Fee of 50 SGD will be applied to your account.';
                            modal.style.display = 'flex';
                        }
                    });
                });
            } catch (err) {
                console.error('Load borrowed keys for lost report error:', err);
                if (reportLostKeysContainer) {
                    reportLostKeysContainer.innerHTML = `<div class="text-center py-8 text-rose-600">Error loading borrowed keys. Please try again.</div>`;
                }
            }
        };
    }

    function initLostConfirm() {
        function closeLostConfirmModal() {
            const modal = document.getElementById('confirmLostModal');
            if (modal) modal.style.display = 'none';
            pendingLostTransaction = null;
        }

        document.getElementById('confirmLostBtn')?.addEventListener('click', async () => {
            if (!pendingLostTransaction) return;
            const { id, code } = pendingLostTransaction;
            const btn = document.querySelector(`.reportLostFromListBtn[data-transaction-id="${id}"]`);
            const originalText = btn?.innerHTML;
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<div class="spinner"></div>';
            }

            try {
                const res = await authenticatedFetch(`/api/user/transactions/${id}/lost`, { method: 'POST' });
                const data = await res.json();

                if (res.ok) {
                    showNotification('Key Reported Lost', `The key ${code} has been marked as lost. A Key Replacement Fee of 50 SGD has been applied.`, 'warning');
                    await fetchKeys();
                    closeLostConfirmModal();
                    const reportLostModal = document.getElementById('reportLostModal');
                    if (reportLostModal && reportLostModal.style.display === 'flex') {
                        const container = document.getElementById('reportLostKeysListContainer');
                        if (container) {
                            container.innerHTML = '<div class="text-center py-8"><div class="spinner"></div> Refreshing...</div>';
                            setTimeout(() => {
                                if (window.autoLoadLostKeys) {
                                    window.autoLoadLostKeys();
                                }
                            }, 500);
                        }
                    }
                } else {
                    throw new Error(data.error || 'Failed to report lost');
                }
            } catch (err) {
                showNotification('Report Failed', err.message, 'error');
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = originalText;
                }
            }
        });

        document.getElementById('cancelLostBtn')?.addEventListener('click', closeLostConfirmModal);
        document.getElementById('confirmLostModal')?.addEventListener('click', (e) => {
            if (e.target === document.getElementById('confirmLostModal')) closeLostConfirmModal();
        });
    }

    function initExtensionModal() {
        document.getElementById('extensionRequestBtn')?.addEventListener('click', () => {
            const menu = document.getElementById('returnDropdownMenu');
            const chevron = document.getElementById('returnDropdownChevron');
            if (menu) menu.classList.add('hidden');
            if (chevron) chevron.style.transform = 'rotate(0deg)';
            
            const modal = document.getElementById('extensionModal');
            if (modal) modal.style.display = 'flex';
            
            autoLoadExtensionLoans();
        });

        document.getElementById('closeExtensionModalBtn')?.addEventListener('click', () => {
            const modal = document.getElementById('extensionModal');
            if (modal) modal.style.display = 'none';
        });

        async function autoLoadExtensionLoans() {
            const email = getUserEmail();
            const container = document.getElementById('extensionLoansContainer');
            
            if (!email) {
                if (container) {
                    container.innerHTML = '<div class="text-center py-8 text-amber-600">No email found in your profile. Please update your profile.</div>';
                }
                return;
            }

            if (container) {
                container.innerHTML = '<div class="text-center py-8 text-slate-400">Loading your active loans...</div>';
            }

            try {
                const res = await authenticatedFetch(`/api/user/active-borrows?email=${encodeURIComponent(email)}`);
                if (!res.ok) throw new Error('Failed to load loans');
                const loans = await res.json();

                if (!loans.length) {
                    if (container) {
                        container.innerHTML = '<div class="text-center py-8 text-slate-400">You don\'t have any active loans.</div>';
                    }
                    return;
                }

                let html = '<div class="space-y-2">';
                loans.forEach(loan => {
                    html += `
                        <div class="extension-item p-3 border border-gray-200 rounded-xl cursor-pointer hover:bg-purple-50 transition" data-transaction-id="${loan.id}">
                            <div class="flex justify-between items-center">
                                <div>
                                    <div class="font-medium text-slate-800">${escapeHtml(loan.key_code)}</div>
                                    <div class="text-xs text-slate-500">${escapeHtml(loan.brand)} · Due: ${formatDate(loan.planned_return)}</div>
                                </div>
                                <span class="text-xs text-slate-400">Select</span>
                            </div>
                        </div>
                    `;
                });
                html += '</div>';
                if (container) {
                    container.innerHTML = html;
                }

                document.querySelectorAll('.extension-item').forEach(item => {
                    item.addEventListener('click', function() {
                        document.querySelectorAll('.extension-item').forEach(el => el.classList.remove('selected', 'border-purple-400', 'bg-purple-50'));
                        this.classList.add('selected', 'border-purple-400', 'bg-purple-50');
                        
                        const selectionArea = document.getElementById('extensionSelectionArea');
                        if (selectionArea) selectionArea.style.display = 'block';
                        
                        const errorDiv = document.getElementById('extensionError');
                        if (errorDiv) errorDiv.classList.add('hidden');
                        
                        const submitBtn = document.getElementById('submitExtensionBtn');
                        if (submitBtn) {
                            submitBtn.dataset.loanId = this.dataset.transactionId;
                            submitBtn.dataset.email = email;
                        }
                    });
                });
            } catch (err) {
                console.error('Extension load error:', err);
                if (container) {
                    container.innerHTML = '<div class="text-center py-8 text-rose-600">Error loading loans. Please try again.</div>';
                }
            }
        }

        document.getElementById('submitExtensionBtn')?.addEventListener('click', async function() {
            const loanId = parseInt(this.dataset.loanId);
            const email = this.dataset.email || getUserEmail();
            const newReturnDate = document.getElementById('extensionNewReturnDate').value;
            const extensionError = document.getElementById('extensionError');

            if (!loanId) {
                if (extensionError) {
                    extensionError.textContent = 'Please select a loan to extend.';
                    extensionError.classList.remove('hidden');
                }
                return;
            }

            if (!newReturnDate) {
                if (extensionError) {
                    extensionError.textContent = 'Please select a new return date.';
                    extensionError.classList.remove('hidden');
                }
                return;
            }

            if (extensionError) extensionError.classList.add('hidden');
            this.disabled = true;
            this.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting...';

            try {
                const res = await authenticatedFetch('/api/requests/extend', {
                    method: 'POST',
                    body: JSON.stringify({
                        transaction_id: loanId,
                        new_return_date: newReturnDate,
                        borrower_email: email
                    })
                });
                const data = await res.json();

                if (res.ok) {
                    showNotification('Extension Requested', 'Your extension request has been submitted. Awaiting admin approval.', 'success');
                    const modal = document.getElementById('extensionModal');
                    if (modal) modal.style.display = 'none';
                    fetchKeys();
                } else {
                    throw new Error(data.error || 'Extension request failed');
                }
            } catch (err) {
                if (extensionError) {
                    extensionError.textContent = err.message;
                    extensionError.classList.remove('hidden');
                }
            } finally {
                this.disabled = false;
                this.innerHTML = 'Submit extension request';
            }
        });
    }

    function startPolling() {
        if (pollInterval) clearInterval(pollInterval);
        fetchKeys();
        pollInterval = setInterval(fetchKeys, 5000);
    }

    async function init() {
        const isAuthenticated = await checkAuth();
        if (isAuthenticated) {
            const loadingContainer = document.getElementById('loadingContainer');
            const mainContentWrapper = document.getElementById('mainContentWrapper');

            if (loadingContainer) {
                loadingContainer.style.display = 'none';
            }
            if (mainContentWrapper) {
                mainContentWrapper.style.display = 'block';
            }

            fetchCsrfToken();
            initEventListeners();
            initFilters();
            initReturnDropdown();
            initReturnModal();
            initReportLost();
            initLostConfirm();
            initExtensionModal();
            startPolling();
        }
    }

    document.addEventListener('DOMContentLoaded', init);
})();