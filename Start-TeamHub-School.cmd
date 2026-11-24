@echo off
setlocal
pushd "%~dp0" || exit /b 1
node -e "const fs=require('node:fs'), cp=require('node:child_process'), path=require('node:path'); const exe=path.resolve('desktop/release/win-unpacked/TeamHub.exe'); const name='TOY_HARNESS_DEEPSEEK_API_KEY'; const key=require('node:util').parseEnv(fs.readFileSync('toy-harness/.env.sustech.local','utf8'))[name]; if (!key) throw new Error('Missing school API key'); const app=cp.spawn(exe,[],{env:{...process.env,[name]:key},detached:true,stdio:'ignore'}); app.unref()"
if errorlevel 1 pause
popd
