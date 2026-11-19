# AI Clip Maker
Запуск: `cp .env.example .env`, впишите ключи, затем `node --env-file=.env server.js` (нужны Node ≥ 20.10, ffmpeg, ffprobe; для YouTube — yt-dlp). Тест пайплайна: `npm test` (использует локальный мок внешних API, ключи не нужны).
Render: Docker-сервис + Persistent Disk на /data, ключи в Environment (см. render.yaml).
Ключи: OPENAI_API_KEY (речь), ANTHROPIC_API_KEY (анализ).
Ограничения: хранение в JSON-файлах (не PostgreSQL), очередь в памяти процесса, кадрирование без трекинга лица (центр/слева/справа), анализ только по речи (без визуального анализа сцен).
