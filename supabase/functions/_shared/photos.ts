// Мгновенный запуск обработки фото (удаление фона) в GitHub Actions.
// Расписание GitHub для редко обновляемых репозиториев срабатывает с задержкой в часы,
// поэтому при появлении новых фото функция сама запускает workflow «Фото: удаление фона».
// Нужны секреты Edge Functions: PHOTO_TRIGGER_TOKEN (fine-grained токен GitHub с правом Actions: write)
// и PHOTO_TRIGGER_REPO (owner/repo). Без них фото обрабатываются по расписанию, как раньше.
import { env } from './env.ts';

export function photoTriggerConfigured(): boolean {
  return !!(env('PHOTO_TRIGGER_TOKEN') && env('PHOTO_TRIGGER_REPO'));
}

/** Запустить обработку. Повторные вызовы безопасны: в GitHub одновременно идёт один запуск и ждёт максимум один. */
export async function kickPhotoProcessing(): Promise<boolean> {
  const token = env('PHOTO_TRIGGER_TOKEN');
  const repo = env('PHOTO_TRIGGER_REPO');
  if (!token || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return false;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/photo-processing.yml/dispatches`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'keep-market-bot',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main' }),
    });
    if (res.status !== 204) {
      console.error(`[photos] запуск обработки не удался: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch {
    console.error('[photos] запуск обработки: сетевая ошибка');
    return false;
  }
}
