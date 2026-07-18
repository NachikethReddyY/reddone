ALTER TABLE "users"
  ADD COLUMN "username" VARCHAR(30),
  ADD COLUMN "displayUsername" VARCHAR(30);

-- Existing credential owners keep email sign-in as a compatibility path. Give
-- them a deterministic username as well, using the email prefix when it is
-- valid and an id-derived suffix only when prefixes collide.
WITH username_candidates AS (
  SELECT
    "id",
    CASE
      WHEN LENGTH(LOWER(REGEXP_REPLACE(SPLIT_PART("email", '@', 1), '[^a-zA-Z0-9_.]', '', 'g'))) >= 3
        THEN LEFT(LOWER(REGEXP_REPLACE(SPLIT_PART("email", '@', 1), '[^a-zA-Z0-9_.]', '', 'g')), 30)
      ELSE 'owner'
    END AS candidate
  FROM "users"
), ranked_candidates AS (
  SELECT
    "id",
    candidate,
    ROW_NUMBER() OVER (PARTITION BY candidate ORDER BY "id") AS candidate_rank
  FROM username_candidates
)
UPDATE "users" AS target
SET
  "username" = CASE
    WHEN ranked.candidate_rank = 1 THEN ranked.candidate
    ELSE LEFT(ranked.candidate, 17) || '_' || SUBSTRING(MD5(target."id"), 1, 12)
  END,
  "displayUsername" = CASE
    WHEN ranked.candidate_rank = 1 THEN ranked.candidate
    ELSE LEFT(ranked.candidate, 17) || '_' || SUBSTRING(MD5(target."id"), 1, 12)
  END
FROM ranked_candidates AS ranked
WHERE target."id" = ranked."id";

CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
