import json, csv, math, argparse, copy
import shutil
from PIL import Image, ImageDraw
from pathlib import Path
import cv2
import numpy as np
from tqdm import tqdm

# CLI 파라미터 파싱
parser = argparse.ArgumentParser(description="swITch Map Maker CLI")
parser.add_argument("-t", "--task", type=str, required=True, choices=["build", "preview", "video"], help="수행할 작업을 선택하세요")
parser.add_argument("-s", "--setting", type=str, required=True, default="setting.json", help="세팅 파일 경로를 입력하세요")
args = parser.parse_args()

# 세팅파일 읽기
try:
    with open(args.setting, 'r', encoding='utf-8') as f:
        settings = json.load(f)
except FileNotFoundError:
    print(f"[세팅 파일 로드] 파일 {args.setting}을 찾을 수 없습니다.")
else:
    print(f"[세팅 파일 로딩] 성공!")

# 타일맵 이미지 불러오기
tile_store = {}
for i, tiles in enumerate(settings["tile_data"]):
    with Image.open(settings["asset_path"]+tiles["file"]) as img:
        tile_image = img.convert("RGBA")
        tile_image = tile_image.resize((256, 256))
        temp = {
            "physics": tiles["physics"], # 0은 바닥 1은 벽
            "image": tile_image,
            "index": i
        }
        tile_store[int(tiles["num"])] = temp
        print(f"[타일 이미지 로딩] {i+1}/{len(settings['tile_data'])} - {tiles['name']} 로딩완료")

# 맵 데이터 불러오기
map_store = []
map_dir = Path(settings["map_file_path"])
map_files = list(map_dir.glob("*.json"))
for i, map_file in enumerate(map_files):
    with open(map_file, 'r', encoding='utf-8') as f:
        map_info = json.load(f)
    with open(settings["map_file_path"]+map_info["data"], 'r', encoding='utf-8') as f:
        map_data = list(csv.reader(f))
    data = []
    events = {}
    for y in range(map_info["size"]):
        data.append([])
        for x in range(map_info["size"]):
            # csv 형식
            # (시작타일)/(변경 틱):(변경타일)/.../*:(변경타일-그 순간 벽인 경우에만 사용됨)
            temp = map_data[y][x].split("/")
            new_temp = []
            new_temp.append([0, int(temp[0])])
            for item in temp[1:]:
                a, b = item.split(":")
                if a == '*':
                    new_temp.append([a, int(b)])
                else:
                    if int(a) in events:
                        events[int(a)].append((x, y, int(b)))
                    else:
                        events[int(a)] = [(x, y, int(b))]
                    new_temp.append([int(a), int(b)])
            data[y].append(new_temp)
    print(f"[맵 데이터 처리] {i+1}/{len(map_files)} - {map_info['name']} 맵 로딩완료")
    # 시뮬레이션
    barrier_index = 0
    barrier_speed = map_info["barrier"]
    endpoint = map_info["size"] * 128
    crt_tick = 0
    map_size = map_info["size"]
    crt_map = []
    for y in range(map_info["size"]):
        crt_map.append([])
        for x in range(map_info["size"]):
            crt_map[y].append(data[y][x][0][1])
    initial_map = copy.deepcopy(crt_map)
    timeline = {}
    while barrier_index < endpoint:
        crt_tick += 1
        barrier_index += barrier_speed
        temp_change = {}
        # 해당 타일이 배리어에 완전히 가려지기 전의 변경만 반영(최적화)
        if crt_tick in events:
            for x, y, new_tile in events[crt_tick]:
                distance = min(x, y, map_size-x-1, map_size-y-1) * 256 - barrier_index
                if distance >= -256:
                    temp_change[(x, y)] = (crt_map[y][x],new_tile)
                    crt_map[y][x] = new_tile
        # 혹시라도 벽이면 부숴야함
        checking_distance = barrier_index // 256 + 1
        checking_index = set()
        for t in range(checking_distance, map_size-checking_distance):
            checking_index.add((checking_distance, t))
            checking_index.add((map_size-checking_distance-1, t))
            checking_index.add((t, checking_distance))
            checking_index.add((t, map_size-checking_distance-1))
        for x, y in checking_index:
            if tile_store[crt_map[y][x]]["physics"] in [1, 3]:
                if (x, y) not in temp_change:
                    temp_change[(x, y)] = (crt_map[y][x], data[y][x][-1][1])
                    crt_map[y][x] = data[y][x][-1][1]
                else:
                    if temp_change[(x, y)][0] == data[y][x][-1][1]:
                        del temp_change[(x, y)]
                    else:
                        temp_change[(x, y)][1] =data[y][x][-1][1]
                    crt_map[y][x] = data[y][x][-1][1]
        if len(temp_change) != 0:
            temp_c = []
            for key, value in temp_change.items():
                temp_c.append((key[0], key[1], value[1]))
            timeline[crt_tick] = temp_c

    # start_pos 계산
    start_positions = {}
    cx = (map_size - 1) / 2.0
    cy = (map_size - 1) / 2.0

    for player_count in range(3, 9):
        radius = (map_size * (0.7 + (player_count - 3) * 0.03)) / 2.0

        positions = []
        for k in range(player_count):
            angle = 2* math.pi * k / player_count + (2*math.pi * player_count / 18)
            sx = max(0, min(int(round(cx + radius * math.cos(angle))), map_size - 1))
            sy = max(0, min(int(round(cy + radius * math.sin(angle))), map_size - 1))

            if tile_store[initial_map[sy][sx]]["physics"] == 1:
                search_limit = max(5, map_size // 2)
                found_alt = False
                orig_dist_center = math.hypot(sx-cx, sy-cy)
                for r_search in range(1, search_limit):
                    candidates = []
                    for dy in range(-r_search, r_search + 1):
                        for dx in range(-r_search, r_search + 1):
                            if max(abs(dx), abs(dy)) == r_search:
                                nx, ny = sx + dx, sy + dy
                                if 0 <= nx < map_size and 0 <= ny < map_size:
                                    if tile_store[initial_map[ny][nx]]["physics"] != 1:
                                        cand_dist_center = math.hypot(nx-cx, ny-cy)
                                        dist_from_orig = math.hypot(dx, dy)
                                        score = dist_from_orig - 0.5 * (cand_dist_center - orig_dist_center)

                                        candidates.append((score, nx, ny))
                    if candidates:
                        candidates.sort(key=lambda item: item[0])
                        sx, sy = candidates[0][1], candidates[0][2]
                        found_alt = True
                        break
            positions.append([sx * 256 + 128, sy * 256 + 128])

        start_positions[player_count] = positions


    map_store.append({
        "name": map_info["name"],
        "barrier_speed": barrier_speed,
        "size": map_info["size"],
        "initial_map": initial_map,
        "timeline": timeline,
        "start_pos": start_positions,
    })
    print(f"[맵 시뮬레이션] - {map_info['name']} 완료(총 {crt_tick}틱)")

# TASK 실행
out_dir = Path(settings.get("output_path", "./build"))
if out_dir.resolve() != Path.cwd().resolve() and out_dir.exists():
    shutil.rmtree(out_dir)
if args.task == "build":
    out_dir = Path(settings.get("output_path", "./"))
    out_dir.mkdir(parents=True, exist_ok=True)

    num_tiles = len(tile_store)
    cols = math.ceil(math.sqrt(num_tiles))
    rows = math.ceil(num_tiles / cols)

    tileset_img = Image.new("RGBA", (cols * 256, rows * 256))
    for t_id, t_info in tile_store.items():
        idx = t_info["index"]
        gx = idx % cols
        gy = idx // cols
        tileset_img.paste(t_info["image"], (gx * 256, gy * 256))

    tileset_img.save(out_dir / "tileset.webp", format="WEBP", lossless=True)
    print(f"[빌드] 타일셋 생성 완료 (크기: {cols}x{rows}) -> tileset.webp")

    server_maps = {}
    client_maps = {}

    for temp_map in map_store:
        m_name = temp_map["name"]
        m_size = temp_map["size"]
        b_speed = temp_map["barrier_speed"]

        srv_init_map = []
        cli_init_map = []

        for y in range(m_size):
            srv_init_map.append([tile_store[t_id]["physics"] for t_id in temp_map["initial_map"][y]])
            cli_init_map.append([tile_store[t_id]["index"] for t_id in temp_map["initial_map"][y]])

        srv_timeline = {}
        cli_timeline = {}

        for tick, changes in temp_map["timeline"].items():
            srv_timeline[tick] = [[x, y, tile_store[t_id]["physics"]] for x, y, t_id in changes]
            cli_timeline[tick] = [[x, y, tile_store[t_id]["index"]] for x, y, t_id in changes]

        server_maps[m_name] = {
            "size": m_size, "barrier_speed": b_speed,
            "initial_map": srv_init_map, "timeline": srv_timeline,
            "start_pos": temp_map["start_pos"]
        }
        client_maps[m_name] = {
            "s": m_size, "b": b_speed,
            "i": cli_init_map, "t": cli_timeline,
            "p": temp_map["start_pos"]
        }

    with open(out_dir / "server_maps.json", "w", encoding="utf-8") as f:
        json.dump(server_maps, f, ensure_ascii=False, separators=(',', ':'))
    with open(out_dir / "client_maps.json", "w", encoding="utf-8") as f:
        json.dump(client_maps, f, ensure_ascii=False, separators=(',', ':'))

    print(f"[빌드] 서버/클라이언트 JSON 맵 세트(총 {len(map_store)}개 맵) 병합 저장 완료!")

elif args.task == "preview":
    out_base_dir = Path(settings.get("output_path", "./"))

    preview_colors = {
        3: ((0, 122, 255, 255), 120),  # 파랑
        4: ((255, 59, 48, 255), 110),  # 빨강
        5: ((52, 199, 89, 255), 100),  # 초록
        6: ((255, 204, 0, 255), 90),  # 노랑
        7: ((175, 82, 222, 255), 80),  # 보라
        8: ((0, 200, 255, 255), 70)  # 하늘색
    }

    def overlay_start_positions(base_img, start_pos_data, m_size):
        canvas_copy = base_img.copy()
        draw = ImageDraw.Draw(canvas_copy)

        cx_px = m_size * 128
        cy_px = m_size * 128

        for p_cnt, (color, _) in preview_colors.items():
            if p_cnt in start_pos_data:
                ratio = 0.7 + (int(p_cnt) - 3) * 0.03
                radius_px = ratio * m_size * 128

                line_color = color[:3] + (120,)
                draw.ellipse(
                    [cx_px - radius_px, cy_px - radius_px, cx_px + radius_px, cy_px + radius_px],
                    outline=line_color, width=5
                )

        for p_cnt, (color, radius) in preview_colors.items():
            if p_cnt in start_pos_data:
                for cx_px, cy_px in start_pos_data[p_cnt]:
                    draw.ellipse(
                        [cx_px - radius, cy_px - radius, cx_px + radius, cy_px + radius],
                        fill=color, outline=(255, 255, 255, 255), width=3
                    )
        return canvas_copy

    for temp_map in map_store:
        m_name = temp_map["name"]
        m_size = temp_map["size"]

        map_out_dir = out_base_dir / m_name
        map_out_dir.mkdir(parents=True, exist_ok=True)

        preview_img = Image.new("RGBA", (256 * m_size, 256 * m_size))
        for y in range(m_size):
            for x in range(m_size):
                t_id = temp_map["initial_map"][y][x]
                preview_img.paste(tile_store[t_id]["image"], (x * 256, y * 256))

        initial_dotted = overlay_start_positions(preview_img, temp_map["start_pos"], m_size)
        initial_dotted.save(map_out_dir / "initial.png", format="PNG", lossless=True, quality=100)

        for tick in sorted(temp_map["timeline"].keys()):
            changes = temp_map["timeline"][tick]
            for x, y, new_tile_id in changes:
                preview_img.paste(tile_store[new_tile_id]["image"], (x * 256, y * 256))

            preview_img.save(map_out_dir / f"{tick}tick.png", format="PNG", lossless=True, quality=100)

        print(f"[미리보기 생성] {m_name} 맵 폴더 내 틱별 이미지 생성 완료!")

elif args.task == "video":
    out_dir = Path(settings.get("output_path", "./build"))
    out_dir.mkdir(parents=True, exist_ok=True)

    v_tile_size = 32
    video_tiles = {
        t_id: t_info["image"].resize((v_tile_size, v_tile_size), Image.Resampling.BILINEAR)
        for t_id, t_info in tile_store.items()
    }

    for temp_map in map_store:
        m_name = temp_map["name"]
        m_size = temp_map["size"]
        b_speed = temp_map["barrier_speed"]

        video_dims = (m_size * v_tile_size, m_size * v_tile_size)
        output_video_path = out_dir / f"{m_name}_simulation.mp4"

        fourcc = cv2.VideoWriter_fourcc(*'mp4v')
        video_writer = cv2.VideoWriter(str(output_video_path), fourcc, 60.0, video_dims)

        base_canvas = Image.new("RGBA", video_dims)
        for y in range(m_size):
            for x in range(m_size):
                t_id = temp_map["initial_map"][y][x]
                if t_id in video_tiles:
                    base_canvas.paste(video_tiles[t_id], (x * v_tile_size, y * v_tile_size))

        endpoint = m_size * 128
        barrier_index = 0.0
        crt_tick = 0
        total_frames = math.ceil(endpoint / b_speed)


        for _ in tqdm(range(total_frames), desc=f"[{m_name}] 렌더링 진행률", unit="프레임"):
            crt_tick += 1
            barrier_index += b_speed

            if crt_tick in temp_map["timeline"]:
                for x, y, new_tile_id in temp_map["timeline"][crt_tick]:
                    if new_tile_id in video_tiles:
                        base_canvas.paste(video_tiles[new_tile_id], (x * v_tile_size, y * v_tile_size))

            frame_img = base_canvas.copy()

            draw = ImageDraw.Draw(frame_img)

            scale = v_tile_size / 256
            barrier_px = barrier_index * scale

            safe_x1 = barrier_px
            safe_y1 = barrier_px
            safe_x2 = video_dims[0] - barrier_px
            safe_y2 = video_dims[1] - barrier_px

            barrier_color = (0, 0, 0, 80)

            draw.rectangle([0, 0, video_dims[0], safe_y1], fill=barrier_color)
            draw.rectangle([0, safe_y2, video_dims[0], video_dims[1]], fill=barrier_color)
            draw.rectangle([0, safe_y1, safe_x1, safe_y2], fill=barrier_color)
            draw.rectangle([safe_x2, safe_y1, video_dims[0], safe_y2], fill=barrier_color)

            draw.rectangle([safe_x1, safe_y1, safe_x2, safe_y2], outline=(255, 255, 255, 150), width=1)

            open_cv_frame = np.array(frame_img.convert("RGB"))
            open_cv_frame = cv2.cvtColor(open_cv_frame, cv2.COLOR_RGB2BGR)
            video_writer.write(open_cv_frame)

        video_writer.release()
else:
    print("작업 오류")