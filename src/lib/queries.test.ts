import test, { before } from 'node:test';
import assert from 'node:assert/strict';

// Тесты читают снимок из репозитория, а не локальную SQLite: результат
// не должен зависеть от того, запускали ли на этой машине `npm run seed`.
process.env.RADAR_STORAGE = 'snapshot';

// Импорт отложен до установки переменной: queries тянет snapshot.ts,
// который выбирает источник при первом обращении.
type Queries = typeof import('./queries');
let q: Queries;

before(async () => {
  q = await import('./queries');
});

const ALL = { from: '2026-08-19', to: '2026-08-25' };

test('в снимке семь дней данных', async () => {
  assert.deepEqual(await q.listDates(), [
    '2026-08-19', '2026-08-20', '2026-08-21',
    '2026-08-22', '2026-08-23', '2026-08-24', '2026-08-25',
  ]);
});

test('виджеты меняются при смене дня — иначе смена даты ни на что не влияет', async () => {
  const days = ['2026-08-20', '2026-08-22', '2026-08-25'];
  const totals = await Promise.all(days.map((d) => q.shopTotals(d, d)));
  const drivers = await Promise.all(
    days.map(async (d) => (await q.summaryByCriterion(d, d)).find((x) => x.criterion === 'driver')!),
  );

  const asKey = (t: Awaited<ReturnType<typeof q.shopTotals>>) => `${t.green}/${t.yellow}/${t.red}`;
  assert.equal(new Set(totals.map(asKey)).size, days.length, 'счётчики лавок совпали у разных дней');

  const driverKey = new Set(drivers.map((d) => `${d.green}/${d.yellow}/${d.red}`));
  assert.equal(driverKey.size, days.length, 'счётчики по водителю совпали у разных дней');
});

test('за один день счётчики — точные, не усреднённые', async () => {
  const day = '2026-08-25';
  const t = await q.shopTotals(day, day);
  assert.equal(t.days, 1);
  assert.equal(t.green + t.yellow + t.red, 80, 'все 80 лавок распределены по статусам');
  assert.equal(t.total, 80);
});

test('за период счётчики усреднены по дням и не вырождаются в «все красные»', async () => {
  const period = await q.shopTotals(ALL.from, ALL.to);
  assert.equal(period.days, 7);
  assert.ok(
    period.green + period.yellow + period.red <= period.total,
    'среднее за день не может превышать число лавок',
  );

  // Среднее обязано лежать между минимумом и максимумом посуточных значений.
  const daily = await Promise.all(
    (await q.listDates()).map((d) => q.shopTotals(d, d)),
  );
  const reds = daily.map((d) => d.red);
  assert.ok(
    period.red >= Math.min(...reds) && period.red <= Math.max(...reds),
    `среднее ${period.red} вне диапазона посуточных [${Math.min(...reds)}, ${Math.max(...reds)}]`,
  );
});

test('фильтр по РМ сужает выборку и счётчики', async () => {
  const all = await q.shopTotals('2026-08-25', '2026-08-25');
  const one = await q.shopTotals('2026-08-25', '2026-08-25', 'Осин');
  assert.equal(one.total, 9);
  assert.ok(one.red <= all.red);
  assert.ok(one.green + one.yellow + one.red <= one.total);
});

test('сумма по критерию не превышает числа лавок под фильтром', async () => {
  for (const range of [['2026-08-25', '2026-08-25'], [ALL.from, ALL.to]] as const) {
    for (const s of await q.summaryByCriterion(range[0], range[1])) {
      assert.ok(
        s.green + s.yellow + s.red + s.missing === 80,
        `${s.criterion}: ${s.green}+${s.yellow}+${s.red}+${s.missing} ≠ 80`,
      );
    }
  }
});

test('наполнение витрины считается за весь период, а не за один день', async () => {
  const day = await q.showcaseStats('2026-08-25', '2026-08-25');
  const period = await q.showcaseStats(ALL.from, ALL.to);
  assert.ok(period.filled >= 1);
  assert.notEqual(day.avg, period.avg, 'среднее за день и за неделю не должно совпадать');
  for (const s of [day, period]) {
    if (s.avg != null) assert.ok(s.avg >= 0 && s.avg <= 1);
  }
});

test('произвольный период отдаёт только свои дни', async () => {
  const { dates } = await q.radar({ from: '2026-08-21', to: '2026-08-23' });
  assert.deepEqual(dates, ['2026-08-21', '2026-08-22', '2026-08-23']);
});

test('период без данных не ломает выдачу', async () => {
  const { dates, rows } = await q.radar({ from: '2026-07-01', to: '2026-07-15' });
  assert.deepEqual(dates, []);
  assert.deepEqual(rows, []);

  const t = await q.shopTotals('2026-07-01', '2026-07-15');
  assert.deepEqual([t.green, t.yellow, t.red, t.days], [0, 0, 0, 0]);

  const fill = await q.showcaseStats('2026-07-01', '2026-07-15');
  assert.equal(fill.avg, null);
});
