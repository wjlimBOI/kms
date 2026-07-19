(function() {
    'use strict';

    let csrfToken = null;
    let csrfFetchPromise = null;

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

    document.addEventListener('DOMContentLoaded', () => {
        fetchCsrfToken();
    });

    (function redirectIfLoggedIn() {
        const token = localStorage.getItem('kms_token');
        if (token) {
            let user = null;
            try { user = JSON.parse(localStorage.getItem('kms_user')); } catch (e) {}
            if (user && user.role) {
                window.location.href = user.role === 'admin' ? '/admin' : '/';
                return;
            }
            window.location.href = '/';
        }
    })();

    const loginForm = document.getElementById('loginForm');
    const usernameInput = document.getElementById('username');
    const passwordInput = document.getElementById('password');
    const usernameError = document.getElementById('usernameError');
    const passwordError = document.getElementById('passwordError');
    const errorDiv = document.getElementById('errorMsg');
    const errorText = document.getElementById('errorText');
    const lockoutDiv = document.getElementById('lockoutMsg');
    const lockoutText = document.getElementById('lockoutText');
    const loginBtn = document.getElementById('loginBtn');
    const lockoutWarningDiv = document.getElementById('lockoutWarning');
    const lockoutWarningText = document.getElementById('lockoutWarningText');

    const toggleBtn = document.querySelector('.toggle-password');
    const toggleIcon = toggleBtn.querySelector('i');

    toggleBtn.addEventListener('click', function() {
        const type = passwordInput.getAttribute('type') === 'password' ? 'text' : 'password';
        passwordInput.setAttribute('type', type);
        toggleIcon.classList.toggle('fa-eye');
        toggleIcon.classList.toggle('fa-eye-slash');
    });

    const registerModal = document.getElementById('registerModal');
    const openRegisterBtn = document.getElementById('openRegisterModalBtn');
    const closeRegisterBtn = document.getElementById('closeRegisterModalBtn');
    const cancelRegisterBtn = document.getElementById('cancelRegisterBtn');
    const registerForm = document.getElementById('registerForm');
    const regName = document.getElementById('regName');
    const regEmail = document.getElementById('regEmail');
    const regNameError = document.getElementById('regNameError');
    const regEmailError = document.getElementById('regEmailError');
    const registerAlert = document.getElementById('registerAlert');
    const registerBtn = document.getElementById('registerBtn');

    const infoTrigger = document.getElementById('infoTrigger');
    const tooltipPopup = document.getElementById('tooltipPopup');

    let failedAttempts = 0;

    function hideAllAlerts() {
        errorDiv.classList.add('hidden');
        lockoutDiv.classList.add('hidden');
    }

    function showError(msg) {
        errorText.textContent = msg;
        errorDiv.classList.remove('hidden');
        lockoutDiv.classList.add('hidden');
    }

    function showLockout(msg) {
        lockoutText.textContent = msg;
        lockoutDiv.classList.remove('hidden');
        errorDiv.classList.add('hidden');
        lockoutWarningDiv.classList.remove('visible');
    }

    function showRegisterAlert(msg, type) {
        registerAlert.textContent = msg;
        registerAlert.className = 'modal-alert visible ' + type;
    }

    function hideRegisterAlert() {
        registerAlert.className = 'modal-alert';
    }

    usernameInput.addEventListener('input', () => {
        usernameError.classList.remove('visible');
        hideAllAlerts();
    });
    passwordInput.addEventListener('input', () => {
        passwordError.classList.remove('visible');
        hideAllAlerts();
    });

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        usernameError.classList.remove('visible');
        passwordError.classList.remove('visible');
        hideAllAlerts();

        const username = usernameInput.value.trim();
        const password = passwordInput.value;

        let valid = true;
        if (!username) {
            usernameError.textContent = 'Username is required';
            usernameError.classList.add('visible');
            valid = false;
        }
        if (!password) {
            passwordError.textContent = 'Password is required';
            passwordError.classList.add('visible');
            valid = false;
        }
        if (!valid) return;

        const originalText = loginBtn.innerHTML;
        loginBtn.disabled = true;
        loginBtn.innerHTML = '<div class="spinner"></div> Authenticating...';

        try {
            const csrf = await getCsrfToken();
            if (!csrf) {
                showError('Failed to get CSRF token. Please refresh and try again.');
                loginBtn.disabled = false;
                loginBtn.innerHTML = originalText;
                return;
            }

            const response = await fetch('/api/auth/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrf,
                    'X-Requested-With': 'XMLHttpRequest'
                },
                body: JSON.stringify({ username, password }),
                credentials: 'include'
            });

            const data = await response.json();

            if (response.ok && data.token) {
                failedAttempts = 0;
                lockoutWarningDiv.classList.remove('visible');

                localStorage.setItem('kms_token', data.token);
                const user = data.user || {
                    username: username,
                    role: data.role || 'user',
                    name: data.name || username
                };
                localStorage.setItem('kms_user', JSON.stringify(user));

                if (data.mustChangePassword) {
                    window.location.href = '/change-password';
                    return;
                }

                window.location.href = data.role === 'admin' ? '/admin' : '/';
                return;
            }

            if (response.status === 403) {
                lockoutWarningDiv.classList.remove('visible');
                showLockout(data.error || 'Account is temporarily locked.');
            } else if (response.status === 401) {
                failedAttempts++;
                const remaining = 5 - failedAttempts;

                if (remaining > 0 && remaining <= 3) {
                    lockoutWarningText.textContent =
                        `⚠️ Warning: You have ${remaining} out of 5 attempts remaining. Your account will be locked after 5 failed attempts.`;
                    lockoutWarningDiv.classList.add('visible');
                } else {
                    lockoutWarningDiv.classList.remove('visible');
                }

                if (remaining <= 0) {
                    lockoutWarningDiv.classList.remove('visible');
                    showLockout('Account is temporarily locked due to too many failed attempts.');
                } else {
                    showError('Invalid username or password.');
                }
            } else {
                showError(data.error || 'An error occurred. Please try again.');
            }
        } catch (err) {
            console.error('Login error:', err);
            showError('Network error. Please check your connection.');
        } finally {
            loginBtn.disabled = false;
            loginBtn.innerHTML = originalText;
        }
    });

    function openModal() {
        registerModal.classList.add('active');
        regName.value = '';
        regEmail.value = '';
        hideRegisterAlert();
        regNameError.classList.remove('visible');
        regEmailError.classList.remove('visible');
        registerBtn.disabled = false;
        registerBtn.innerHTML = 'Submit request';
    }

    function closeModal() {
        registerModal.classList.remove('active');
        tooltipPopup.classList.remove('show');
    }

    openRegisterBtn.addEventListener('click', openModal);
    closeRegisterBtn.addEventListener('click', closeModal);
    cancelRegisterBtn.addEventListener('click', closeModal);
    registerModal.addEventListener('click', function(e) {
        if (e.target === this) closeModal();
    });

    infoTrigger.addEventListener('click', function(e) {
        e.stopPropagation();
        tooltipPopup.classList.toggle('show');
    });
    document.addEventListener('click', function(e) {
        if (!e.target.closest('.info-trigger')) {
            tooltipPopup.classList.remove('show');
        }
    });

    regName.addEventListener('input', () => {
        regNameError.classList.remove('visible');
        hideRegisterAlert();
    });
    regEmail.addEventListener('input', () => {
        regEmailError.classList.remove('visible');
        hideRegisterAlert();
    });

    registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        regNameError.classList.remove('visible');
        regEmailError.classList.remove('visible');
        hideRegisterAlert();

        const name = regName.value.trim();
        const email = regEmail.value.trim();

        let valid = true;
        if (!name) {
            regNameError.textContent = 'Name is required';
            regNameError.classList.add('visible');
            valid = false;
        }
        if (!email || !email.includes('@')) {
            regEmailError.textContent = 'Valid email is required';
            regEmailError.classList.add('visible');
            valid = false;
        }
        if (!valid) return;

        const originalText = registerBtn.innerHTML;
        registerBtn.disabled = true;
        registerBtn.innerHTML = '<div class="spinner"></div> Submitting...';

        try {
            const csrf = await getCsrfToken();
            if (!csrf) {
                showRegisterAlert('Failed to get CSRF token. Please refresh and try again.', 'error');
                registerBtn.disabled = false;
                registerBtn.innerHTML = originalText;
                return;
            }

            const response = await fetch('/api/auth/register-request', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrf,
                    'X-Requested-With': 'XMLHttpRequest'
                },
                body: JSON.stringify({ name, email }),
                credentials: 'include'
            });

            const data = await response.json();

            if (response.ok) {
                showRegisterAlert('✅ Request submitted! You will receive an email once approved.', 'success');
                registerBtn.innerHTML = '✓ Done';
                setTimeout(() => {
                    closeModal();
                    registerBtn.disabled = false;
                    registerBtn.innerHTML = originalText;
                }, 2500);
            } else {
                showRegisterAlert(data.error || 'Submission failed. Please try again.', 'error');
                registerBtn.disabled = false;
                registerBtn.innerHTML = originalText;
            }
        } catch (err) {
            console.error('Registration error:', err);
            showRegisterAlert('Network error. Please check your connection.', 'error');
            registerBtn.disabled = false;
            registerBtn.innerHTML = originalText;
        }
    });
})();