export type Category = {
  slug: string;
  name: string;
  image?: string | null;
};

export const categories: Category[] = [
  { slug: 'prof-zapchasti', name: '\u041f\u0440\u043e\u0444.\u0437\u0430\u043f\u0447\u0430\u0441\u0442\u0438', image: null },
  { slug: 'bytovye', name: '\u0411\u044b\u0442\u043e\u0432\u044b\u0435', image: null },
  { slug: 'category-3', name: '\u041a\u0430\u0442\u0435\u0433\u043e\u0440\u0438\u044f 3', image: null },
  { slug: 'category-4', name: '\u041a\u0430\u0442\u0435\u0433\u043e\u0440\u0438\u044f 4', image: null }
];
