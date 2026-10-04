@echo off
setlocal

rem Push the contents of the folder containing this .bat file to GitHub.
cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
    echo ERROR: Git was not found. Install Git for Windows, then run this file again.
    pause
    exit /b 1
)

for /f "delims=" %%R in ('git rev-parse --show-toplevel 2^>nul') do set "GIT_ROOT=%%R"
if not defined GIT_ROOT (
    git init -b main
    if errorlevel 1 goto :fail
) else (
    cd /d "%GIT_ROOT%"
)

echo.
echo Enter the HTTPS or SSH URL of your GitHub repository.
set /p "REPO_URL=Repository URL: "
if not defined REPO_URL (
    echo ERROR: No repository URL was entered.
    goto :fail
)

for /f "delims=" %%R in ('git remote get-url origin 2^>nul') do set "CURRENT_URL=%%R"
if not defined CURRENT_URL (
    git remote add origin "%REPO_URL%"
    if errorlevel 1 goto :fail
) else if /i not "%CURRENT_URL%"=="%REPO_URL%" (
    echo.
    echo Existing origin: %CURRENT_URL%
    choice /C YN /N /M "Replace origin with the URL you entered? [Y/N] "
    if errorlevel 2 (
        echo Push cancelled. Existing origin was kept.
        pause
        exit /b 1
    )
    git remote set-url origin "%REPO_URL%"
    if errorlevel 1 goto :fail
)

for /f "delims=" %%B in ('git branch --show-current 2^>nul') do set "CURRENT_BRANCH=%%B"
if not defined CURRENT_BRANCH (
    git checkout -B main
    if errorlevel 1 goto :fail
) else if /i not "%CURRENT_BRANCH%"=="main" (
    git branch -M main
    if errorlevel 1 goto :fail
)

git add -A
if errorlevel 1 goto :fail

git diff --cached --quiet
if errorlevel 1 (
    call :ensure_identity
    if errorlevel 1 goto :fail
    call :make_commit
    if errorlevel 1 goto :fail
)

git rev-parse --verify HEAD >nul 2>nul
if errorlevel 1 (
    echo ERROR: There is no commit to push. Add at least one file and try again.
    goto :fail
)

echo.
echo Pushing to origin/main...
git push -u origin main
if errorlevel 1 (
    echo.
    echo Push failed. Check the repository URL, GitHub access, and whether the remote
    echo already has commits that are not in this folder. No force push was attempted.
    goto :fail
)

echo.
echo Push completed successfully.
pause
exit /b 0

:fail
echo.
echo The push did not complete. Review the message above.
pause
exit /b 1



:ensure_identity
for /f "delims=" %%N in ('git config user.name 2^>nul') do set "GIT_NAME=%%N"
for /f "delims=" %%E in ('git config user.email 2^>nul') do set "GIT_EMAIL=%%E"
if not defined GIT_NAME (
    echo Git needs an author name for the commit.
    set /p "GIT_NAME=Name: "
)
if not defined GIT_EMAIL (
    echo Git needs an author email for the commit.
    set /p "GIT_EMAIL=Email: "
)
if not defined GIT_NAME (
    echo ERROR: No author name was entered.
    exit /b 1
)
if not defined GIT_EMAIL (
    echo ERROR: No author email was entered.
    exit /b 1
)
git config user.name "%GIT_NAME%"
if errorlevel 1 exit /b 1
git config user.email "%GIT_EMAIL%"
if errorlevel 1 exit /b 1
exit /b 0




:make_commit
echo.
set /p "COMMIT_MSG=Commit message [Update repository contents] (press Enter for default): "
if not defined COMMIT_MSG set "COMMIT_MSG=Update repository contents"
git commit -m "%COMMIT_MSG%"
exit /b %errorlevel%
