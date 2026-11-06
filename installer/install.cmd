@echo off
setlocal
title Claude Salesforce Bridge - Installer

where node >nul 2>nul
if errorlevel 1 (
  echo ------------------------------------------------------------------
  echo ^|
  echo ^|  CLAUDE SALESFORCE BRIDGE
  echo ^|
  echo ------------------------------------------------------------------
  echo.
  echo   Node.js was not found.
  echo   Install Node.js LTS from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

node "%~dp0installer.js" %*
if errorlevel 1 pause
