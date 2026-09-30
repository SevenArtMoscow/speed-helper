# SPEED HELPER

Telegram Mini App prototype for short-term shifts and workers.

## Current prototype

This repository contains the latest V5.8 frontend/proxy prototype used for testing the core flow:

- contractor creates a shift;
- worker finds a shift;
- worker applies;
- contractor accepts or rejects;
- accepted worker joins the shift team;
- team chat and statuses are synchronized through Supabase.

## Stack in this prototype

- HTML / CSS / JavaScript
- Telegram Mini App
- Netlify static hosting / proxy rules
- Supabase Auth / PostgreSQL / RLS

## Security note

The repository contains a Supabase **publishable** client key. Publishable keys are intended for client-side use; database access must remain protected by RLS. Do not commit service-role keys, Telegram bot tokens, database passwords, or other server secrets.

## Status

Prototype only. The production version should use server-verified Telegram initData, a proper backend/API for critical actions, logging/monitoring, staging/production environments, and load testing.
