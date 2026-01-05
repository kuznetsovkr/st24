# Her Shop — заготовка интернет-магазина

Базовый каркас фронтенда и бэкенда под MVP интернет-магазина (React + Node/Express + PostgreSQL).

## Что уже есть
- Frontend (Vite + React + TS) с маршрутами под карту сайта: `/`, `/catalog`, `/catalog/:slug`, `/cart`, `/about`, `/b2b`, `/privacy`, `/terms`, `/admin` и 404.
- Две модалки на фронте: быстрая карточка товара и вход по телефону (демо-флоу).
- Базовая верстка с шапкой/футером и плейсхолдерами страниц под наполнение.
- Backend (Express + TS) с `GET /api/health` и готовой точкой входа для будущих API.

## Локальный запуск
Установите зависимости в воркспейсах:
```bash
npm install
```

Запуск фронтенда:
```bash
npm run dev --workspace client
```

Запуск бэкенда:
```bash
npm run dev --workspace server
```

Сборка бэкенда:
```bash
npm run build --workspace server
```

## Переменные окружения
Скопируйте `server/.env.example` в `server/.env` и при необходимости укажите `PORT` и `DATABASE_URL`.

## Стек
- Frontend: Vite, React, TypeScript, React Router.
- Backend: Node, Express, TypeScript.
- DB: PostgreSQL (подключение будет добавлено позже).

## Ближайшие шаги
- Подключить реальный список категорий/товаров с бэка.
- Добавить API-клиент и стейт-менеджмент для корзины/авторизации.
- Прописать реальные тексты для юридических страниц.
