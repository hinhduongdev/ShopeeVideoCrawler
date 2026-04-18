@echo off
setlocal enabledelayedexpansion

echo [BUILD] Starting obfuscation and release process...

:: Define paths using current script directory as base
set "SOURCE_DIR=%~dp0"
set "TARGET_DIR=%~dp0..\ShopeeVideoCrawler_Release"

:: 1. Create target directory if it doesn't exist
if not exist "%TARGET_DIR%" (
    mkdir "%TARGET_DIR%"
    echo [INFO] Created target directory.
)

:: 2. Run Obfuscator
:: We use call npx to ensure the script continues after npx finishes
echo [INFO] Obfuscating JS files...
call npx javascript-obfuscator "%SOURCE_DIR%." --output "%TARGET_DIR%" --config "%SOURCE_DIR%obfuscator-config.json" --exclude node_modules,manifest.json,popup.html,package.json,package-lock.json,build_demo.bat,.git,.gitignore

:: 3. Copy static assets (Crucial step)
echo [INFO] Copying static assets...

:: Use /Y to overwrite without asking, and double quotes for safety
copy /Y "%SOURCE_DIR%manifest.json" "%TARGET_DIR%\"
copy /Y "%SOURCE_DIR%popup.html" "%TARGET_DIR%\"

:: If you have icons or images, uncomment the line below:
:: xcopy /E /I /Y "%SOURCE_DIR%images" "%TARGET_DIR%\images"

echo ---------------------------------------------------
echo [DONE] Release is ready at: %TARGET_DIR%
pause