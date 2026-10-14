// POST /photo-kick {} — запустить удаление фона сразу (после загрузки фото в админке или «Обработать заново»).
// Только владелец/администратор. Если запуск не настроен — фото обработаются по расписанию.
import { serve, json, HttpError } from '../_shared/http.ts';
import { requireUser, rateLimit } from '../_shared/supabase.ts';
import { kickPhotoProcessing } from '../_shared/photos.ts';

serve('photo-kick', async (req) => {
  const auth = await requireUser(req);
  await rateLimit(`photo-kick:user:${auth.userId}`, 20, 60);
  const { data: isAdmin } = await auth.db.rpc('is_admin');
  if (isAdmin !== true) throw new HttpError(403, 'FORBIDDEN');
  const started = await kickPhotoProcessing();
  return json(req, { started });
});
