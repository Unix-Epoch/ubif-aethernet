-- Linkshell pairing (src/linkshell.js): a hash of the secret the PC made at pair/start and kept out of the QR code. A pairing that
-- has one answers status, finish and cancel only to a caller that sends the secret. Additive only; NULL = started without one.
ALTER TABLE linkshell_pairs ADD COLUMN pc_secret_hash TEXT;
