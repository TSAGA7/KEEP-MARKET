-- KEEP MARKET · Остаток по умолчанию — 3 шт.
-- Новые размеры (из бота, админки, импорта) сразу получают остаток 3, подтверждённый в момент создания,
-- чтобы товар можно было заказать без отдельного подтверждения. Владелец меняет число прямо в карточке товара.

alter table public.product_variants alter column stock_qty set default 3;

-- Новый вариант с остатком 0, который никто не подтверждал (импорт из Telegram, старые черновики) → 3
create or replace function app.variants_default_stock() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.stock_qty = 0 and new.stock_confirmed_at is null then
    new.stock_qty := 3;
  end if;
  if new.stock_confirmed_at is null and new.stock_qty > 0 then
    new.stock_confirmed_at := now();
  end if;
  return new;
end $$;
create trigger product_variants_1_default_stock before insert on public.product_variants
  for each row execute function app.variants_default_stock();

-- Уже созданные варианты, у которых остаток ни разу не задавали (0 и «подтверждён: никогда») → 3
update public.product_variants
   set stock_qty = 3, stock_confirmed_at = now()
 where stock_qty = 0 and stock_confirmed_at is null;
