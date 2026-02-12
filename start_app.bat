@echo off
echo Starting LocalSend Server...
start "LocalSend Server" cmd /k "cd server && node index.js"

echo Starting LocalSend Client...
start "LocalSend Client" cmd /k "cd client && node node_modules/vite/bin/vite.js"

echo ===================================================
echo  LocalSend is running!
echo  Access via: http://localhost:5173
echo  To use on other devices, use the Network IP shown in the terminal.
echo ===================================================
pause
