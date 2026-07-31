import type {Metadata} from "next";

import {RegisterForm} from "@/components/agent/register-form";

export const metadata: Metadata = {
  title: "Регистрация кошелька — Synth Wallet",
};

export default function RegisterPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-20">
      <div className="mb-12">
        <h1 className="text-3xl font-medium tracking-tight sm:text-4xl">
          Новый кошелёк
        </h1>
        <p className="mt-4 text-muted-foreground">
          Выберите сценарий владения. Документы, почта и подтверждения не понадобятся —
          ни на этом шаге, ни дальше.
        </p>
      </div>

      <RegisterForm />
    </div>
  );
}
