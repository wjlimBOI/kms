(function() {
    'use strict';

    let isRedirecting = false;
    let redirectTimer = null;
    let isRedirectingFromModal = false;

    function redirectToLogin() {
        if (isRedirecting) return;
        isRedirecting = true;
        localStorage.removeItem('kms_token');
        localStorage.removeItem('kms_user');
        sessionStorage.clear();
        document.cookie.split(";").forEach(function(c) {
            document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
        });
        window.location.href = '/login?t=' + Date.now();
    }

    function showSuccessModal() {
        var modal = document.getElementById('successModal');
        if (!modal) return;
        modal.classList.add('active');
    }

    function hideSuccessModal() {
        var modal = document.getElementById('successModal');
        if (!modal) return;
        modal.classList.remove('active');
    }

    function showMessage(text, type) {
        var messageDiv = document.getElementById('message');
        if (!messageDiv) return;
        messageDiv.textContent = text;
        messageDiv.className = 'alert-box ' + type;
        messageDiv.classList.remove('hidden');
    }

    function initToggleButtons() {
        var toggleButtons = document.querySelectorAll('.toggle-password');

        toggleButtons.forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();

                var wrapper = this.closest('.input-wrapper');
                if (!wrapper) return;

                var input = wrapper.querySelector('input');
                var icon = this.querySelector('i');

                if (!input || !icon) return;

                if (input.type === 'password') {
                    input.type = 'text';
                    icon.classList.remove('fa-eye');
                    icon.classList.add('fa-eye-slash');
                } else {
                    input.type = 'password';
                    icon.classList.remove('fa-eye-slash');
                    icon.classList.add('fa-eye');
                }

                input.focus();
            });
        });
    }

    document.addEventListener('DOMContentLoaded', function() {
        // Initialize CSRF token
        ensureCsrfToken();

        var form = document.getElementById('resetForm');
        var newPasswordInput = document.getElementById('newPassword');
        var confirmPasswordInput = document.getElementById('confirmPassword');
        var newPasswordError = document.getElementById('newPasswordError');
        var confirmPasswordError = document.getElementById('confirmPasswordError');
        var messageDiv = document.getElementById('message');
        var resetBtn = document.getElementById('resetBtn');
        var successModalBtn = document.getElementById('successModalBtn');

        if (!form || !newPasswordInput || !confirmPasswordInput || !resetBtn) {
            console.error('Required elements not found');
            return;
        }

        // Initialize toggle buttons
        initToggleButtons();

        // Success modal button - redirect to login
        if (successModalBtn) {
            successModalBtn.addEventListener('click', function() {
                if (isRedirectingFromModal) return;
                isRedirectingFromModal = true;
                hideSuccessModal();
                if (redirectTimer) {
                    clearTimeout(redirectTimer);
                    redirectTimer = null;
                }
                redirectToLogin();
            });
        }

        // Close modal on overlay click
        var modal = document.getElementById('successModal');
        if (modal) {
            modal.addEventListener('click', function(e) {
                if (e.target === this) {
                    // Don't close on overlay click - let user use the button
                }
            });
        }

        function validateForm() {
            var newPwd = newPasswordInput.value.trim();
            var confirm = confirmPasswordInput.value.trim();
            resetBtn.disabled = !(newPwd && confirm);
        }

        [newPasswordInput, confirmPasswordInput].forEach(function(field) {
            field.addEventListener('input', function() {
                document.querySelectorAll('.field-error').forEach(function(el) {
                    el.classList.remove('visible');
                });
                validateForm();
            });
        });

        var urlParams = new URLSearchParams(window.location.search);
        var token = urlParams.get('token');

        if (!token) {
            showMessage('Invalid or missing reset token. Please request a new password reset.', 'alert-error');
            resetBtn.disabled = true;
            return;
        }

        (async function checkToken() {
            try {
                var csrf = await getCsrfToken();
                if (!csrf) {
                    showMessage('Failed to get CSRF token. Please refresh and try again.', 'alert-error');
                    return;
                }

                var res = await fetch('/api/auth/validate-password-token', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': csrf,
                        'X-Requested-With': 'XMLHttpRequest'
                    },
                    body: JSON.stringify({ token: token }),
                    credentials: 'include'
                });

                var data = await res.json();

                if (!data.valid) {
                    showMessage('Invalid or expired reset token. Please request a new password reset.', 'alert-error');
                    resetBtn.disabled = true;
                }
            } catch (err) {
                console.error('Token verification error:', err);
                showMessage('Network error. Please try again.', 'alert-error');
                resetBtn.disabled = true;
            }
        })();

        form.addEventListener('submit', async function(e) {
            e.preventDefault();

            document.querySelectorAll('.field-error').forEach(function(el) {
                el.classList.remove('visible');
            });
            if (messageDiv) messageDiv.classList.add('hidden');

            var newPwd = newPasswordInput.value.trim();
            var confirm = confirmPasswordInput.value.trim();

            var valid = true;

            if (!newPwd) {
                if (newPasswordError) {
                    newPasswordError.textContent = 'New password is required.';
                    newPasswordError.classList.add('visible');
                }
                valid = false;
            } else if (newPwd.length < 16) {
                if (newPasswordError) {
                    newPasswordError.textContent = 'Password must be at least 16 characters.';
                    newPasswordError.classList.add('visible');
                }
                valid = false;
            }

            if (!confirm) {
                if (confirmPasswordError) {
                    confirmPasswordError.textContent = 'Please confirm your new password.';
                    confirmPasswordError.classList.add('visible');
                }
                valid = false;
            } else if (newPwd && confirm && newPwd !== confirm) {
                if (confirmPasswordError) {
                    confirmPasswordError.textContent = 'Passwords do not match.';
                    confirmPasswordError.classList.add('visible');
                }
                valid = false;
            }

            if (!valid) return;

            var originalText = resetBtn.innerHTML;
            resetBtn.disabled = true;
            resetBtn.innerHTML = '<div class="spinner"></div> Resetting...';

            try {
                var csrf = await getCsrfToken();
                if (!csrf) {
                    showMessage('Failed to get CSRF token. Please refresh and try again.', 'alert-error');
                    resetBtn.disabled = false;
                    resetBtn.innerHTML = originalText;
                    return;
                }

                var res = await fetch('/api/auth/set-password-from-token', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': csrf,
                        'X-Requested-With': 'XMLHttpRequest'
                    },
                    body: JSON.stringify({
                        token: token,
                        new_password: newPwd
                    }),
                    credentials: 'include'
                });

                var data = await res.json();

                if (res.ok) {
                    // Clear any existing timer
                    if (redirectTimer) {
                        clearTimeout(redirectTimer);
                        redirectTimer = null;
                    }

                    // Clear local storage
                    localStorage.removeItem('kms_token');
                    localStorage.removeItem('kms_user');
                    sessionStorage.clear();

                    // Show success modal
                    showSuccessModal();

                    // Reset button state
                    resetBtn.disabled = false;
                    resetBtn.innerHTML = originalText;

                    // Auto-redirect after 5 seconds
                    redirectTimer = setTimeout(function() {
                        if (!isRedirectingFromModal) {
                            isRedirectingFromModal = true;
                            hideSuccessModal();
                            redirectToLogin();
                        }
                    }, 5000);

                } else {
                    showMessage(data.error || 'Failed to reset password. Please try again.', 'alert-error');
                    resetBtn.disabled = false;
                    resetBtn.innerHTML = originalText;
                }
            } catch (err) {
                console.error('Reset password error:', err);
                showMessage('Network error. Please try again.', 'alert-error');
                resetBtn.disabled = false;
                resetBtn.innerHTML = originalText;
            }
        });

        // Handle page visibility change to prevent loops
        document.addEventListener('visibilitychange', function() {
            if (document.hidden) {
                if (redirectTimer) {
                    clearTimeout(redirectTimer);
                    redirectTimer = null;
                }
            }
        });

        // Handle beforeunload to prevent loops
        window.addEventListener('beforeunload', function() {
            if (redirectTimer) {
                clearTimeout(redirectTimer);
                redirectTimer = null;
            }
        });
    });
})();