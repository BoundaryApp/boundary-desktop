## Notes from the planning call

We agreed to ship the export feature in the next release and leave the import side for later. Priya pointed out that most support requests are about getting data out, not in.

Dan raised the CSV encoding bug again. Files with accented names open as garbage in older spreadsheet apps. He'll add a byte order mark and test it in the two apps customers mention most.

Nobody wanted to commit to a date for the mobile layout. The current design breaks on narrow screens, but fixing it means reworking the table component, and we don't have anyone free until next month. We'll revisit it at the next call.
