-- 방 하나가 여러 경기를 치른다. room_id의 유일 인덱스는 재경기의 결과 행 자체를 만들 수 없게 막아서,
-- 두 번째 경기부터 전적도 결과 화면도 사라지게 했다. "방의 현재 경기"는 result_recorded_at이
-- 비어 있는 행 하나라는 규칙으로 지킨다.
DROP INDEX IF EXISTS "matches_room_id_idx";--> statement-breakpoint
CREATE INDEX "matches_room_id_idx" ON "matches" USING btree ("room_id");
