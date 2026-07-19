@echo off
REM ==========================================
REM  KMS Audit Chain Validation Batch Script
REM ==========================================

REM Set full path to Node.js (find yours with `where node`)
set NODE=C:\Program Files\nodejs\node.exe

REM Set project directory (change if needed)
set PROJECT_DIR=C:\Workshop\kms

REM Set log directory (user profile – always writable)
set LOG_DIR=%USERPROFILE%\logs\kms
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

REM Change to project directory
cd /d "%PROJECT_DIR%"

REM Log start
echo %date% %time% - Starting audit validation >> "%LOG_DIR%\audit.log"

REM Run Node script
"%NODE%" scripts\auditCron.js >> "%LOG_DIR%\audit.log" 2>&1

REM Check exit code
if %errorlevel% neq 0 (
    echo %date% %time% - ERROR: Audit validation failed >> "%LOG_DIR%\audit.log"
) else (
    echo %date% %time% - Audit validation completed >> "%LOG_DIR%\audit.log"
)

REM Optional: keep window open if double‑clicked (comment out for scheduled tasks)
pause