-- 030_message_records_voicemail_type.sql
-- Allow message_type = 'voicemail' on message_records so transcribed voicemails
-- can be logged alongside SMS/MMS in the account history / CDRs.

ALTER TABLE message_records DROP CONSTRAINT IF EXISTS message_records_message_type_check;
ALTER TABLE message_records
  ADD CONSTRAINT message_records_message_type_check
  CHECK (message_type IN ('sms', 'mms', 'voicemail'));
