#!/bin/sh
# ТОЛЬКО ДЛЯ ТЕСТОВ: имитирует интерфейс yt-dlp (в песочнице нет сети для настоящего). Проверяет, как наш код его вызывает.
echo "$@" >> "$FAKE_LOG"
case " $* " in *" --version "*) echo "2099.01.01-test"; exit 0;; esac
case " $* " in *" --help "*) echo "  --js-runtimes RUNTIME"; exit 0;; esac
case " $* " in *" -J "*) echo '{"title":"Fake YT video","duration":90,"uploader":"t","is_live":false,"formats":[{"height":720}]}'; exit 0;; esac
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
out=$(echo "$out" | sed 's/%(ext)s/mp4/')
echo "[download] Destination: $out"; echo "[download]  50.0% of 1MiB"; cp "$FAKE_VIDEO" "$out"; echo "[download] 100% of 1MiB"
