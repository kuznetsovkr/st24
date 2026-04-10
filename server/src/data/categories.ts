export type Category = {
  slug: string;
  name: string;
  image?: string | null;
};

export const categories: Category[] = [
  { slug: 'prof-zapchasti', name: 'Проф.запчасти', image: null },
  { slug: 'bytovye', name: 'Бытовые', image: null },
  { slug: 'category-3', name: 'Категория 3', image: null },
  { slug: 'category-4', name: 'Категория 4', image: null }
];
