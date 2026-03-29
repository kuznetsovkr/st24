import { useMemo } from 'react';
import { SITE_URL, usePageSeo } from '../utils/usePageSeo.ts';

const AboutPage = () => {
  const breadcrumbJsonLd = useMemo(
    () => ({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        {
          '@type': 'ListItem',
          position: 1,
          name: 'Главная',
          item: `${SITE_URL}/`
        },
        {
          '@type': 'ListItem',
          position: 2,
          name: 'О компании',
          item: `${SITE_URL}/about`
        }
      ]
    }),
    []
  );

  usePageSeo(
    'О компании — производитель запчастей для Karcher в России | СТ-24',
    'Информация о компании. Производство и продажа запчастей для техники Karcher. Опыт, качество и доставка по всей России.',
    {
      jsonLd: breadcrumbJsonLd
    }
  );

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">О компании</p>
          <h1>О компании</h1>
          <p className="muted">
            Работаем по всей России, обеспечивая быструю доставку и помощь в подборе необходимых
            деталей. Наша цель — предоставить надежные решения для ремонта и обслуживания техники.
          </p>
        </div>
      </header>
    </div>
  );
};

export default AboutPage;
