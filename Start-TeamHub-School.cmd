@echo off
setlocal
pushd "%~dp0" || exit /b 1
set "TEAMHUB_SCHOOL_APP=desktop\release\win-unpacked"
if exist "desktop\release\win-unpacked-layout-20261126\TeamHub.exe" set "TEAMHUB_SCHOOL_APP=desktop\release\win-unpacked-layout-20261126"
for %%F in (TeamHub.exe icudtl.dat resources.pak resources\app.asar resources\runtime\node.exe resources\runtime\worker.cjs resources\runtime\hub.cjs resources\runtime\hook.mjs) do (
  if not exist "%TEAMHUB_SCHOOL_APP%\%%F" (
    echo TeamHub portable build is incomplete. Missing "%TEAMHUB_SCHOOL_APP%\%%F".
    echo Rebuild it with: npm.cmd --prefix desktop run package:win
    popd
    pause
    exit /b 1
  )
)
node -e "const fs=require('node:fs'), cp=require('node:child_process'), path=require('node:path'); const exe=path.resolve(process.env.TEAMHUB_SCHOOL_APP,'TeamHub.exe'); const name='TOY_HARNESS_DEEPSEEK_API_KEY'; const key=require('node:util').parseEnv(fs.readFileSync('toy-harness/.env.sustech.local','utf8'))[name]; if (!key) throw new Error('Missing school API key'); const env={...process.env,[name]:key}; delete env.ELECTRON_RUN_AS_NODE; const app=cp.spawn(exe,[],{env,detached:true,stdio:'ignore'}); app.once('spawn',()=>app.unref());"
set "TEAMHUB_SCHOOL_EXIT=%errorlevel%"
popd
if not "%TEAMHUB_SCHOOL_EXIT%"=="0" pause
exit /b %TEAMHUB_SCHOOL_EXIT%
