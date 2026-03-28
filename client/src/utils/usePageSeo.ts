import { useEffect } from 'react';

const META_DESCRIPTION_SELECTOR = 'meta[name="description"]';

const getOrCreateDescriptionMeta = () => {
  let description = document.querySelector<HTMLMetaElement>(META_DESCRIPTION_SELECTOR);
  if (!description) {
    description = document.createElement('meta');
    description.setAttribute('name', 'description');
    document.head.appendChild(description);
  }
  return description;
};

export const usePageSeo = (title: string, description: string) => {
  useEffect(() => {
    document.title = title;
    getOrCreateDescriptionMeta().setAttribute('content', description);
  }, [description, title]);
};
