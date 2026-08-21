-- Dispatch scale fix: DispatchService.dispatch()'s GPS-radius candidate query previously had
-- no geographic filter at the database level at all (nationwide scan, capped at 50 rows with
-- no ordering), and no index existed to make the array-containment `skills: { has }` filter
-- fast either. At today's vendor count neither index changes query correctness, only future
-- performance as the table grows toward thousands/tens-of-thousands of rows.
CREATE INDEX "ServiceVendor_currentLatitude_currentLongitude_idx" ON "ServiceVendor"("currentLatitude", "currentLongitude");
CREATE INDEX "ServiceVendor_skills_idx" ON "ServiceVendor" USING GIN ("skills");
