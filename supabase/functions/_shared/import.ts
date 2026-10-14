// Импорт товара из поста поставщика, пересланного боту сотрудником (owner/admin).
// Альбом фото приходит отдельными сообщениями с общим media_group_id — все они попадают в один черновик.
import { adminClient } from './supabase.ts';
import { requireEnv } from './env.ts';
import { tgCall, sendMessage, appUrl } from './telegram.ts';
import { parseSupplierPost } from './domain/import.ts';
import { escapeTelegramHtml as esc } from './domain/telegram.ts';
import { formatRub } from './domain/money.ts';
import { kickPhotoProcessing, photoTriggerConfigured } from './photos.ts';

type PhotoSize = { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number };
export type ImportMessage = {
  message_id: number;
  from?: { id: number };
  chat: { id: number };
  media_group_id?: string;
  caption?: string;
  photo?: PhotoSize[];
  document?: { file_id: string; mime_type?: string; file_size?: number; file_name?: string };
  forward_origin?: { type: string; chat?: { id: number; title?: string; username?: string }; message_id?: number; sender_user_name?: string };
  forward_from_chat?: { id: number; title?: string; username?: string };
  forward_from_message_id?: number;
};

const MAX_BYTES = 15 * 1024 * 1024;

export function hasImportableImage(m: ImportMessage): boolean {
  return !!(m.photo?.length || (m.document && /^image\/(jpeg|png|webp)$/.test(m.document.mime_type ?? '')));
}

export async function isCatalogEditor(telegramId: number): Promise<boolean> {
  const db = adminClient();
  const { data: p } = await db.from('profiles').select('id, is_blocked').eq('telegram_id', telegramId).maybeSingle();
  if (!p || p.is_blocked) return false;
  const { data: roles } = await db.from('user_roles').select('role').eq('user_id', p.id).in('role', ['owner', 'admin']);
  return (roles ?? []).length > 0;
}

async function downloadTelegramFile(fileId: string): Promise<{ bytes: Uint8Array; ext: string; mime: string }> {
  const info = await tgCall<{ file_path: string; file_size?: number }>('getFile', { file_id: fileId });
  if (!info.ok || !info.result?.file_path) throw new Error('TG_GETFILE_FAILED');
  if ((info.result.file_size ?? 0) > MAX_BYTES) throw new Error('FILE_TOO_LARGE');
  const res = await fetch(`https://api.telegram.org/file/bot${requireEnv('TELEGRAM_BOT_TOKEN')}/${info.result.file_path}`);
  if (!res.ok) throw new Error('TG_DOWNLOAD_FAILED');
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error('FILE_TOO_LARGE');
  // Тип определяем по сигнатуре файла, а не по расширению
  const hex = [...bytes.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (hex.startsWith('ffd8ff')) return { bytes, ext: 'jpg', mime: 'image/jpeg' };
  if (hex.startsWith('89504e47')) return { bytes, ext: 'png', mime: 'image/png' };
  if (hex.startsWith('52494646') && hex.slice(16, 24) === '57454250') return { bytes, ext: 'webp', mime: 'image/webp' };
  throw new Error('UNSUPPORTED_IMAGE');
}

export async function importFromMessage(m: ImportMessage): Promise<void> {
  const db = adminClient();
  const origin = m.forward_origin?.chat ?? m.forward_from_chat;
  const groupKey = m.media_group_id ? `mg:${m.chat.id}:${m.media_group_id}` : `msg:${m.chat.id}:${m.message_id}`;
  const parsed = parseSupplierPost(m.caption);

  const { data, error } = await db.rpc('bot_import_upsert', {
    p_actor_telegram_id: m.from?.id,
    p_group_key: groupKey,
    p_title: parsed.title,
    p_description: parsed.description,
    p_raw_caption: m.caption ?? '',
    p_price_kopecks: parsed.priceKopecks,
    p_sizes: parsed.sizes,
    p_source: {
      via: 'telegram_forward',
      chat_id: origin?.id ?? null,
      username: origin?.username ?? null,
      channel_title: origin?.title ?? null,
      message_id: m.forward_origin?.message_id ?? m.forward_from_message_id ?? null,
      slug_base: parsed.slugBase,
    },
  });
  if (error) {
    await sendMessage(m.chat.id, 'Не удалось создать черновик товара. Проверьте, что у вас роль владельца или администратора.');
    return;
  }
  const r = data as { product_id: string; created: boolean; supplier_found?: boolean; retail_kopecks?: number; cost_kopecks?: number | null };

  // Фото: оригинал в Storage, в очередь на удаление фона
  const fileId = m.photo?.length ? (m.photo[m.photo.length - 1] as PhotoSize).file_id : m.document?.file_id;
  let photoError: string | null = null;
  let photoQueued = false;
  if (fileId) {
    try {
      const file = await downloadTelegramFile(fileId);
      const path = `${r.product_id}/orig-${crypto.randomUUID()}.${file.ext}`;
      const up = await db.storage.from('product-images').upload(path, file.bytes, { contentType: file.mime, upsert: false, cacheControl: '31536000' });
      if (up.error) throw new Error('STORAGE_UPLOAD_FAILED');
      const add = await db.rpc('bot_import_add_photo', { p_product_id: r.product_id, p_group_key: groupKey, p_storage_path: path, p_message_id: m.message_id });
      if (add.error) throw new Error('PHOTO_SAVE_FAILED');
      photoQueued = true;
    } catch (e) {
      photoError = (e as Error).message;
    }
  }

  // Первое фото поста запускает удаление фона сразу; остальные фото альбома подхватит тот же запуск
  const kicked = r.created && photoQueued ? await kickPhotoProcessing() : false;

  if (r.created) {
    // В личном чате с ботом кнопка web_app открывает Mini App с авторизацией сотрудника
    const link = appUrl(`admin/products/${r.product_id}`);
    const lines = [
      `<b>Черновик создан</b>: ${esc(parsed.title || 'без названия')}`,
      parsed.priceKopecks ? `Цена из поста: ${esc(formatRub(parsed.priceKopecks))} → ${r.cost_kopecks ? 'записана как закупочная' : 'записана как розничная'}` : 'Цена в посте не найдена — укажите вручную',
      r.retail_kopecks ? `Розничная (с наценкой): ${esc(formatRub(r.retail_kopecks))}` : (r.cost_kopecks ? 'Розничную цену укажите в карточке' : ''),
      parsed.sizes.length ? `Размеры: ${esc(parsed.sizes.join(', '))} (остаток 3 шт. — можно поменять в карточке)` : 'Размеры не найдены — добавьте варианты',
      r.supplier_found ? 'Поставщик определён по каналу' : 'Поставщик не определён — выберите в карточке',
      kicked
        ? 'Фон на фото удалится через 2–5 минут. Остальные фото альбома добавятся в этот же товар.'
        : photoTriggerConfigured()
          ? 'Фон на фото удалится автоматически (запуск обработки не ответил — сработает расписание). Остальные фото альбома добавятся в этот же товар.'
          : 'Фон на фото удаляется по расписанию GitHub — это может занять до нескольких часов. Чтобы ускорить, настройте мгновенный запуск (PHOTO_TRIGGER_TOKEN). Остальные фото альбома добавятся в этот же товар.',
      'Если текст поста пришёл отдельным сообщением — перешлите его следом, он добавится в этот черновик.',
      'Товар не опубликован: проверьте цену, категорию и нажмите «Опубликовать».',
    ].filter(Boolean);
    await sendMessage(m.chat.id, lines.join('\n'), link ? [[{ text: 'Открыть черновик', web_app: { url: link } }]] : undefined);
  }
  if (photoError) {
    await sendMessage(m.chat.id, `Одно фото не удалось сохранить (${esc(photoError)}). Загрузите его вручную в карточке товара.`);
  }
}

/** Текст поста без фото, пересланный сотрудником сразу после альбома → дополнить последний черновик. */
export async function importTextFromMessage(m: { chat: { id: number }; from?: { id: number }; text?: string; caption?: string }): Promise<boolean> {
  const raw = (m.text ?? m.caption ?? '').trim();
  if (!raw || !m.from) return false;
  const parsed = parseSupplierPost(raw);
  const { data, error } = await adminClient().rpc('bot_import_attach_text', {
    p_actor_telegram_id: m.from.id,
    p_title: parsed.title,
    p_description: parsed.description,
    p_raw_caption: raw,
    p_price_kopecks: parsed.priceKopecks,
    p_sizes: parsed.sizes,
  });
  if (error) {
    console.error('[import] attach text failed', error.message?.slice(0, 120));
    return false;
  }
  const r = data as { attached: boolean; product_id?: string; title?: string; changed?: string[] };
  if (!r?.attached || !r.product_id) return false;
  const link = appUrl(`admin/products/${r.product_id}`);
  const what = r.changed?.length ? ` Обновлено: ${esc(r.changed.join(', '))}.` : ' Текст сохранён в заметках товара.';
  await sendMessage(m.chat.id, `Текст добавлен к черновику «${esc(r.title ?? '')}».${what}`,
    link ? [[{ text: 'Открыть черновик', web_app: { url: link } }]] : undefined);
  return true;
}
