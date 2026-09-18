\set ON_ERROR_STOP on
\ir bootstrap.sql
set bkt.staging='on';
\ir ../../sql/staging/100_foundation.sql
\ir ../../sql/staging/101_commands.sql
\ir ../../sql/staging/102_claims.sql
\ir ../../sql/staging/103_operations.sql
\ir ../../sql/staging/104_hardening.sql
\ir ../../sql/staging/105_guest_join.sql
\ir security.sql
