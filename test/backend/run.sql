\set ON_ERROR_STOP on
\ir bootstrap.sql
set bkt.staging='on';
\ir ../../sql/staging/100_foundation.sql
\ir ../../sql/staging/101_commands.sql
\ir ../../sql/staging/102_claims.sql
\ir security.sql
