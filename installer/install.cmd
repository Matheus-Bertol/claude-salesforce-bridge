@echo off
rem Claude Salesforce Bridge - double-click launcher for install.ps1 (options are passed through).
title Claude Salesforce Bridge - Installer
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
exit /b %errorlevel%
