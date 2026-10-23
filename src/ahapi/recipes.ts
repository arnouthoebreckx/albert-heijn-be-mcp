import type { AhClient } from "./client.ts";

/** Allerhande recipe search result. */
export interface RecipeSummary {
  id: number;
  title: string;
  slug: string;
  nutriScore?: string | null;
  courses?: string[];
  time?: { cook?: number | null; oven?: number | null; wait?: number | null };
  serving?: { number: number; type: string };
  rating?: { average?: number | null; count?: number | null } | null;
}

export interface Nutrition {
  value: number;
  unit: string;
  name: string;
}

export interface Recipe {
  id: number;
  title: string;
  description?: string | null;
  href: string;
  cookTime?: number | null;
  nutriScore?: string | null;
  courses?: string[];
  cuisines?: string[];
  servings: { number: number; type: string };
  rating?: { average?: number | null; count?: number | null } | null;
  /** text is the full line ("2 middelgrote uien"); name the ingredient alone ("middelgrote ui"). */
  ingredients: { text: string; name: string }[];
  preparation?: { steps?: string[] } | null;
  nutritions?: Record<"energy" | "carbohydrates" | "fat" | "protein", Nutrition | null> | null;
}

const AH_WEB = new URL("https://www.ah.nl/");

export function recipeUrl(id: number, slug: string): string {
  return new URL(`/allerhande/recept/R-R${id}/${encodeURIComponent(slug)}`, AH_WEB).href;
}

/** href (a path from AH) on www.ah.nl, or fallback if it would lead to another site. */
export function ahPageUrl(href: string, fallback: string): string {
  const url = URL.parse(href, AH_WEB.href);
  return url?.origin === AH_WEB.origin ? url.href : fallback;
}

/** AH returns HTML entities in recipe text, e.g. "1&#189; teen". */
function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return named[e.toLowerCase()] ?? m;
  });
}

export async function searchRecipes(c: AhClient, text: string, size: number): Promise<{ total: number; recipes: RecipeSummary[] }> {
  const query = `query RecipeSearch($query: RecipeSearchParams!) {
  recipeSearch(query: $query) {
    page { total }
    result { id title slug nutriScore courses time { cook oven wait } serving { number type } rating { average count } }
  }
}`;
  const data = await c.graphql<{ recipeSearch: { page?: { total: number }; result: RecipeSummary[] } }>(query, {
    query: { searchText: text, size },
  });
  return {
    total: data.recipeSearch.page?.total ?? 0,
    recipes: data.recipeSearch.result.map((r) => ({ ...r, title: decodeEntities(r.title) })),
  };
}

/** servings scales the ingredient quantities; AH still reports the default in recipe.servings. */
export async function getRecipe(c: AhClient, id: number, servings?: number): Promise<Recipe> {
  const query = `query Recipe($id: Int!, $servings: Int) {
  recipe(id: $id, servings: $servings) {
    id title description href cookTime nutriScore courses cuisines
    servings { number type }
    rating { average count }
    ingredients { text name { singular } }
    preparation { steps }
    nutritions {
      energy { value unit name } carbohydrates { value unit name }
      fat { value unit name } protein { value unit name }
    }
  }
}`;
  const { recipe: r } = await c.graphql<{
    recipe: Omit<Recipe, "ingredients"> & { ingredients: { text: string; name?: { singular?: string } | null }[] };
  }>(query, { id, servings });
  return {
    ...r,
    title: decodeEntities(r.title),
    description: r.description && decodeEntities(r.description),
    ingredients: r.ingredients.map((i) => ({
      text: decodeEntities(i.text),
      name: decodeEntities(i.name?.singular || i.text),
    })),
    preparation: r.preparation && { steps: r.preparation.steps?.map(decodeEntities) },
  };
}
