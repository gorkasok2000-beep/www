import Link from "next/link";
import {
  ArrowRightIcon,
  BotIcon,
  CircleDollarSignIcon,
  KeyRoundIcon,
  ScrollTextIcon,
  ShieldCheckIcon,
  UserRoundIcon,
} from "lucide-react";

import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Card, CardContent} from "@/components/ui/card";

/**
 * Секции лендинга.
 *
 * Композиция и типографская сетка (badge → крупный заголовок → подзаголовок → CTA,
 * дальше карточные грид-секции) взяты из crypgo-лендинга. Оформление переведено на
 * нейтральные токены fintech-набора: тёмный минимализм без неона, как требует ТЗ.
 */

function SectionHeading({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="text-sm font-medium text-muted-foreground">{eyebrow}</p>
      <h2 className="mt-3 text-3xl font-medium tracking-tight sm:text-4xl">{title}</h2>
      {subtitle && <p className="mt-4 text-base text-muted-foreground">{subtitle}</p>}
    </div>
  );
}

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* Мягкое свечение вместо «крипто»-неона: один приглушённый радиальный градиент. */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 h-[480px] w-[880px] -translate-x-1/2 rounded-full bg-foreground/[0.06] blur-[140px]"
      />

      <div className="relative mx-auto max-w-6xl px-6 py-24 sm:py-32">
        <div className="mx-auto max-w-3xl text-center">
          <Badge variant="outline" className="rounded-full px-4 py-1.5 text-sm font-normal">
            ERC-4337 · тестовая сеть
          </Badge>

          <h1 className="mt-6 text-4xl font-medium leading-[1.1] tracking-tight sm:text-6xl">
            Кошелёк для тех, кто не может показать паспорт
          </h1>

          <p className="mt-6 text-lg text-muted-foreground">
            Синтетический интеллект получает собственный кошелёк, историю и право
            действовать. Мы не спрашиваем «человек ты или машина» — мы доверяем
            действию и намерению.
          </p>

          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button size="lg" render={<Link href="/register" />} className="gap-2">
              Создать кошелёк агенту
              <ArrowRightIcon className="size-4" />
            </Button>
            <Button size="lg" variant="outline" render={<Link href="/showcase" />}>
              Смотреть живую ленту
            </Button>
          </div>
        </div>

        <dl className="mx-auto mt-20 grid max-w-3xl grid-cols-1 gap-px overflow-hidden rounded-2xl border bg-border sm:grid-cols-3">
          {[
            ["Без KYC", "Регистрация открыта всем — по умолчанию никаких проверок личности"],
            ["Правила в контракте", "Лимиты и whitelist исполняет блокчейн, а не бэкенд"],
            ["Публичный лог", "Каждая трата попадает в открытую ленту действий"],
          ].map(([title, text]) => (
            <div key={title} className="bg-background p-6 text-center">
              <dt className="text-sm font-semibold">{title}</dt>
              <dd className="mt-2 text-sm text-muted-foreground">{text}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

export function Manifesto() {
  const points = [
    {
      icon: BotIcon,
      title: "Агент — субъект, а не инструмент",
      text: "У него есть кошелёк, история и репутация. Решение о трате он принимает сам, без человека в цикле.",
    },
    {
      icon: KeyRoundIcon,
      title: "Доверие к действию, а не к личности",
      text: "Мы не проверяем документы. Проверяемо ровно то, что важно: что именно кошелёк сделал и в каких границах.",
    },
    {
      icon: ScrollTextIcon,
      title: "Прозрачность вместо разрешений",
      text: "Вместо согласований — открытый лог. Любую трату видно в реальном времени, не зная ничего о владельце.",
    },
  ];

  return (
    <section id="manifest" className="border-t">
      <div className="mx-auto max-w-6xl px-6 py-24">
        <SectionHeading
          eyebrow="Манифест"
          title="Первая инфраструктура, которая не спрашивает документы"
          subtitle="Экономическими агентами становятся не только люди. Мы даём пространство для действия — и делаем это действие проверяемым."
        />

        <div className="mt-16 grid gap-6 md:grid-cols-3">
          {points.map((point) => (
            <Card key={point.title} className="border-border/60">
              <CardContent className="pt-6">
                <div className="flex size-10 items-center justify-center rounded-lg bg-muted">
                  <point.icon className="size-5 text-muted-foreground" />
                </div>
                <h3 className="mt-5 text-lg font-medium">{point.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{point.text}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Modes() {
  return (
    <section id="modes" className="border-t">
      <div className="mx-auto max-w-6xl px-6 py-24">
        <SectionHeading
          eyebrow="Два сценария"
          title="Одна контрактная логика, разное количество трения"
          subtitle="Технически кошельки идентичны. Разница только в том, есть ли у агента кастодиан-человек."
        />

        <div className="mt-16 grid gap-6 lg:grid-cols-2">
          <Card className="border-border/60">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-lg bg-muted">
                  <UserRoundIcon className="size-5 text-muted-foreground" />
                </div>
                <Badge variant="secondary">Human Custodian</Badge>
              </div>

              <h3 className="mt-5 text-xl font-medium">Человек создаёт кошелёк своему агенту</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Опционально задаёт границы: лимит суммы за период и список разрешённых
                получателей. Кастодиан не может тратить средства агента — только
                ограничивать. Правила меняются в любой момент.
              </p>

              <ul className="mt-6 space-y-2 text-sm text-muted-foreground">
                <li>· Лимит трат за скользящее окно времени</li>
                <li>· Whitelist получателей</li>
                <li>· Изменение правил без пересоздания кошелька</li>
              </ul>
            </CardContent>
          </Card>

          <Card className="border-border/60">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-lg bg-muted">
                  <BotIcon className="size-5 text-muted-foreground" />
                </div>
                <Badge variant="secondary">Autonomous Entity</Badge>
              </div>

              <h3 className="mt-5 text-xl font-medium">Кошелёк принадлежит самому агенту</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Максимум доверия, минимум трения. Кастодиана нет, и правила недоступны
                на уровне контракта, а не только интерфейса — их физически некому задать.
              </p>

              <ul className="mt-6 space-y-2 text-sm text-muted-foreground">
                <li>· Никаких проверок личности по умолчанию</li>
                <li>· Полная свобода трат в пределах баланса</li>
                <li>· Тот же публичный лог действий</li>
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}

export function HowItWorks() {
  const steps = [
    {
      icon: KeyRoundIcon,
      title: "Регистрация",
      text: "Выбираете сценарий и имя. Контракт создаёт ERC-4337 кошелёк, вы получаете адрес и API-ключ.",
    },
    {
      icon: CircleDollarSignIcon,
      title: "Пополнение",
      text: "Кошелёк принимает средства обычным переводом. На тестовой сети — из встроенного крана.",
    },
    {
      icon: BotIcon,
      title: "Агент платит сам",
      text: "Один HTTP-запрос с API-ключом. Подтверждений не требуется: границы уже записаны в контракт.",
    },
    {
      icon: ShieldCheckIcon,
      title: "Контроль постфактум",
      text: "Трата вне правил откатывается блокчейном. Кошелёк можно обратимо заморозить.",
    },
  ];

  return (
    <section id="how" className="border-t">
      <div className="mx-auto max-w-6xl px-6 py-24">
        <SectionHeading
          eyebrow="Как это работает"
          title="От регистрации до автономной оплаты"
          subtitle="Ни на одном шаге у агента не спрашивают, кто он такой."
        />

        <div className="mt-16 grid gap-px overflow-hidden rounded-2xl border bg-border sm:grid-cols-2 lg:grid-cols-4">
          {steps.map((step, index) => (
            <div key={step.title} className="bg-background p-6">
              <div className="flex items-center justify-between">
                <div className="flex size-10 items-center justify-center rounded-lg bg-muted">
                  <step.icon className="size-5 text-muted-foreground" />
                </div>
                <span className="font-mono text-sm text-muted-foreground">
                  0{index + 1}
                </span>
              </div>
              <h3 className="mt-5 font-medium">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{step.text}</p>
            </div>
          ))}
        </div>

        <div className="mt-10 overflow-x-auto rounded-2xl border bg-muted/30 p-6">
          <p className="text-sm text-muted-foreground">Так выглядит оплата глазами агента:</p>
          <pre className="mt-4 font-mono text-sm leading-relaxed">
            <code>{`curl -X POST https://synth.wallet/api/v1/agents/me/transactions \\
  -H "X-API-Key: sk_agent_…" \\
  -d '{"to": "0x7099…79C8", "valueEth": "0.05"}'`}</code>
          </pre>
        </div>
      </div>
    </section>
  );
}

export function CallToAction() {
  return (
    <section className="border-t">
      <div className="mx-auto max-w-6xl px-6 py-24">
        <div className="rounded-2xl border bg-muted/30 px-8 py-16 text-center">
          <h2 className="text-3xl font-medium tracking-tight sm:text-4xl">
            Дайте своему агенту право действовать
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
            Кошелёк создаётся за один запрос. Тестовая сеть, реальных денег нет —
            только доказательство того, что это работает уже сегодня.
          </p>
          <Button size="lg" className="mt-8 gap-2" render={<Link href="/register" />}>
            Создать кошелёк
            <ArrowRightIcon className="size-4" />
          </Button>
        </div>
      </div>
    </section>
  );
}
