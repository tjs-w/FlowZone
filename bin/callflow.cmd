@echo off
setlocal EnableExtensions DisableDelayedExpansion

set "CALLFLOW_BUNDLE_PATH=%~dp0..\server\dist\callflow.cjs"
if not exist "%CALLFLOW_BUNDLE_PATH%" (
  >&2 echo {"schema":"callflow/error-v1","code":"unavailable","message":"CallFlow's bundled CLI is unavailable."}
  exit /b 127
)

set "NODE_OPTIONS="
set "NODE_PATH="
set "CALLFLOW_UNSUPPORTED_NODE_FOUND=0"

for %%N in ("%ProgramFiles%\nodejs\node.exe" "%ProgramFiles(x86)%\nodejs\node.exe" "%LocalAppData%\Programs\nodejs\node.exe") do (
  if exist "%%~fN" (
    "%%~fN" -e "const [major,minor]=process.versions.node.split('.').map(Number);process.exit(major>22||(major===22&&minor>=13)?0:1)" <NUL >NUL 2>NUL
    if not errorlevel 1 (
      set "CALLFLOW_NODE=%%~fN"
      goto callflow_run
    )
    set "CALLFLOW_UNSUPPORTED_NODE_FOUND=1"
  )
)

for /f "usebackq delims=" %%N in (`where.exe node.exe 2^>NUL`) do (
  if exist "%%~fN" (
    "%%~fN" -e "const [major,minor]=process.versions.node.split('.').map(Number);process.exit(major>22||(major===22&&minor>=13)?0:1)" <NUL >NUL 2>NUL
    if not errorlevel 1 (
      set "CALLFLOW_NODE=%%~fN"
      goto callflow_run
    )
    set "CALLFLOW_UNSUPPORTED_NODE_FOUND=1"
  )
)

if "%CALLFLOW_UNSUPPORTED_NODE_FOUND%"=="1" (
  >&2 echo {"schema":"callflow/error-v1","code":"unsupported_runtime","message":"CallFlow requires Node.js 22.13.0 or newer."}
  exit /b 126
)

>&2 echo {"schema":"callflow/error-v1","code":"unavailable","message":"Node.js is unavailable for CallFlow."}
exit /b 127

:callflow_run
"%CALLFLOW_NODE%" "%CALLFLOW_BUNDLE_PATH%" %*
exit /b %ERRORLEVEL%
