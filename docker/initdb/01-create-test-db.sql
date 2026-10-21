-- Runs once, the first time the Postgres volume is created.
-- A separate database for the test suite (tests wipe it on every run).
CREATE DATABASE wallet_test;
