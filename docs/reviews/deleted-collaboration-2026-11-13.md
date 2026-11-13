# Deleted collaboration participants (2026-11-13)

Base: main 333c506d; isolated integration checkout only. Participant registry presence is projected independently of immutable historical names and receipts. Removed participants are shown as historical records; previous messages, incomplete fragments and Work links remain accessible. The display no longer claims live replies or advances execution elapsed time for deleted participants. Registry membership changes reset loaded list pagination so old cached rows refresh.

New follow-up admission and new peer operations reject absent participants before creating a receipt/outbox/request. Existing accepted receipt/operation replay is not newly rejected by this gate. No database rows or user artifacts are deleted.

Passed via existing non-esbuild runners: repository SQLite regression; new admission/side-effect gate; original collaboration feedback/recovery/file-watch regression; peer-ingress suite; React DOM deleted-list/detail/followup/Work-link/elapsed regression; complete web/node/scripts typecheck. Fixtures are isolated and use no real model calls. Independent review identified and fixed remaining live-time/preview and host-admission gaps before submission.

During DOM test development, an assertion incorrectly expected the preserved historical fragment to be absent and failed; its large DOM assertion output exceeded the test guard memory cap. The final assertions verify that the fragment is retained but not described as streaming. A whitespace-sensitive duration assertion was corrected to match visible whitespace. Final tests pass with production semantics preserved.

The author's separate candidate runner encountered blocked telemetry network initialization; that run is not reported as passed and no network/security change was made. Integration used its existing permitted project dependencies and runner. No current-user profile, application reload, full-suite run or physical desktop acceptance occurred.
