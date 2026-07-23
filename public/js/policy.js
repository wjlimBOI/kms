(function() {
    'use strict';

    const CONFIG = {
        toastDuration: 3000,
        scrollThreshold: 300,
    };

    // Toast System
    function showToast(message, type = 'info') {
        const toast = document.getElementById('toast');
        const toastMessage = document.getElementById('toastMessage');

        if (!toast || !toastMessage) {
            alert(message);
            return;
        }

        toast.className = 'toast';
        if (type === 'success') toast.classList.add('success');
        if (type === 'error') toast.classList.add('error');

        toastMessage.textContent = message;
        toast.classList.add('show');

        clearTimeout(toast._hideTimeout);
        toast._hideTimeout = setTimeout(() => {
            toast.classList.remove('show');
        }, CONFIG.toastDuration);
    }

    // DOM Elements
    const backBtn = document.getElementById('backButton');
    const printBtn = document.getElementById('printBtn');
    const shareBtn = document.getElementById('shareBtn');
    const scrollBtn = document.getElementById('scrollTopBtn');
    const toast = document.getElementById('toast');
    const toastClose = toast?.querySelector('.toast-close');

    // Back Button
    if (backBtn) {
        backBtn.addEventListener('click', (e) => {
            e.preventDefault();
            showToast('Going back...', 'info');

            if (window.history.length > 1) {
                const ref = document.referrer;
                if (ref && new URL(ref).hostname === window.location.hostname) {
                    window.history.back();
                    return;
                }
            }
            window.location.href = '/';
        });
    }

    // Print Button
    if (printBtn) {
        const originalHtml = printBtn.innerHTML;

        printBtn.addEventListener('click', () => {
            showToast('Preparing print...', 'info');

            printBtn.classList.add('loading');
            printBtn.innerHTML = `
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" style="animation: spin 1s linear infinite;" width="16" height="16" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Preparing...
            `;

            setTimeout(() => {
                window.print();

                const restorePrint = () => {
                    printBtn.classList.remove('loading');
                    printBtn.innerHTML = originalHtml;
                    window.removeEventListener('afterprint', restorePrint);
                    showToast('Print ready!', 'success');
                };
                window.addEventListener('afterprint', restorePrint);

                setTimeout(() => {
                    if (printBtn.classList.contains('loading')) {
                        printBtn.classList.remove('loading');
                        printBtn.innerHTML = originalHtml;
                    }
                }, 5000);
            }, 300);
        });
    }

    // Share Button
    if (shareBtn) {
        if (!navigator.share) {
            shareBtn.style.opacity = '0.5';
            shareBtn.title = 'Share not supported – link will be copied';
        }

        shareBtn.addEventListener('click', () => {
            const url = window.location.href;

            const copyToClipboard = (text) => {
                if (navigator.clipboard?.writeText) {
                    navigator.clipboard.writeText(text)
                        .then(() => showToast('Link copied to clipboard!', 'success'))
                        .catch(() => fallbackCopy(text));
                } else {
                    fallbackCopy(text);
                }
            };

            const fallbackCopy = (text) => {
                const textarea = document.createElement('textarea');
                textarea.value = text;
                textarea.style.cssText = 'position:fixed;opacity:0;left:-9999px;top:-9999px;';
                document.body.appendChild(textarea);
                textarea.select();
                try {
                    if (document.execCommand('copy')) {
                        showToast('Link copied to clipboard!', 'success');
                    } else {
                        showToast('Unable to copy link', 'error');
                    }
                } catch {
                    showToast('Unable to copy link', 'error');
                }
                document.body.removeChild(textarea);
            };

            if (navigator.share) {
                navigator.share({
                    title: 'Privacy Policy & Terms of Service | Key Master System',
                    text: 'Key Master System - Privacy Policy and Terms of Service',
                    url: url
                })
                .then(() => showToast('Shared successfully!', 'success'))
                .catch((err) => {
                    if (err.name !== 'AbortError') {
                        copyToClipboard(url);
                    }
                });
            } else {
                copyToClipboard(url);
            }
        });
    }

    // Tabs
    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabPanels = document.querySelectorAll('.tab-panel');

    if (tabButtons.length) {
        const switchTab = (btn) => {
            const target = btn.dataset.tab;

            tabButtons.forEach(b => {
                b.classList.remove('active');
                b.setAttribute('aria-selected', 'false');
            });
            btn.classList.add('active');
            btn.setAttribute('aria-selected', 'true');

            tabPanels.forEach(p => p.classList.remove('active'));
            const panel = document.getElementById(target + '-panel');
            if (panel) panel.classList.add('active');

            try {
                sessionStorage.setItem('activeTab', target);
            } catch {}
        };

        tabButtons.forEach((btn, idx) => {
            btn.addEventListener('click', () => switchTab(btn));

            btn.addEventListener('keydown', (e) => {
                const total = tabButtons.length;
                let next = -1;
                if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    next = (idx + 1) % total;
                } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    next = (idx - 1 + total) % total;
                } else if (e.key === 'Home') {
                    e.preventDefault();
                    next = 0;
                } else if (e.key === 'End') {
                    e.preventDefault();
                    next = total - 1;
                }
                if (next >= 0) {
                    tabButtons[next].focus();
                    switchTab(tabButtons[next]);
                }
            });
        });

        try {
            const savedTab = sessionStorage.getItem('activeTab');
            if (savedTab) {
                const found = document.querySelector(`.tab-btn[data-tab="${savedTab}"]`);
                if (found) switchTab(found);
            }
        } catch {}
    }

    // Scroll to Top
    if (scrollBtn) {
        const handleScroll = () => {
            scrollBtn.classList.toggle('visible', window.scrollY > CONFIG.scrollThreshold);
        };

        window.addEventListener('scroll', handleScroll);
        handleScroll();

        scrollBtn.addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }

    // Toast Close
    if (toastClose) {
        toastClose.addEventListener('click', () => {
            toast.classList.remove('show');
        });
    }

    // Keyboard Shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && toast?.classList.contains('show')) {
            toast.classList.remove('show');
        }
        if (e.altKey && (e.key === '1' || e.key === '2')) {
            e.preventDefault();
            const idx = parseInt(e.key, 10) - 1;
            const tabs = document.querySelectorAll('.tab-btn');
            if (tabs[idx]) tabs[idx].click();
        }
    });

    // Welcome Toast
    try {
        if (!sessionStorage.getItem('visited')) {
            sessionStorage.setItem('visited', 'true');
            setTimeout(() => {
                showToast('Welcome! Use tabs to switch between policies.', 'info');
            }, 1000);
        }
    } catch {}

    // Expose for testing
    window.__test = {
        showToast,
        clickBack: () => backBtn?.click(),
        clickPrint: () => printBtn?.click(),
        clickShare: () => shareBtn?.click(),
    };

})();