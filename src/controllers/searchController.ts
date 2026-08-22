import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendResponse } from "../utils/apiResponse.js";
import { prisma } from "../utils/prisma.js";

/** One aggregate query the public search modal calls as the person types.
 * Every source here is real data (published only) — no mock/sample results. */
export const search = asyncHandler(async (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim();
  if (q.length < 2) {
    sendResponse(res, 200, { teachers: [], books: [], darsat: [], ifaida: [] });
    return;
  }

  const [teachers, books, darsat, ifaida] = await Promise.all([
    prisma.teacher.findMany({ where: { name: { contains: q } }, take: 5 }),
    prisma.book.findMany({ where: { status: "PUBLISHED", title: { contains: q } }, take: 5 }),
    prisma.dars.findMany({ where: { status: "PUBLISHED", title: { contains: q } }, take: 5 }),
    prisma.ifaida.findMany({ where: { status: "PUBLISHED", title: { contains: q } }, take: 5 }),
  ]);

  sendResponse(res, 200, {
    teachers: teachers.map((t) => ({ id: t.id, title: t.name, subtitle: t.role, url: `/abarimu/${t.id}` })),
    books: books.map((b) => ({ id: b.id, title: b.title, subtitle: b.author, url: `/ibitabo` })),
    darsat: darsat.map((d) => ({ id: d.id, title: d.title, subtitle: d.type, url: `/abarimu` })),
    ifaida: ifaida.map((i) => ({ id: i.id, title: i.title, subtitle: i.category, url: `/inyandiko/${i.id}` })),
  });
});
