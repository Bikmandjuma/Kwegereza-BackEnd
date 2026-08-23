import type { Request, Response } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { sendError, sendResponse } from "../utils/apiResponse.js";
import { prisma } from "../utils/prisma.js";

const QUESTION_TYPES = new Set(["MULTIPLE_CHOICE", "FILL_BLANK"]);

function publicExam(e: any) {
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    category: e.category,
    durationMinutes: e.durationMinutes,
    passingScorePercent: e.passingScorePercent,
    allowMultipleAttempts: e.allowMultipleAttempts,
    status: e.status,
    publishedAt: e.publishedAt,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    createdByName: e.createdBy?.fullName,
    questionCount: e.questions?.length ?? e._count?.questions,
  };
}

// ===================== Admin: exam CRUD =====================

export const listAdmin = asyncHandler(async (req: Request, res: Response) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = Math.min(100, Math.max(1, Number(req.query.perPage) || 20));
  const search = String(req.query.search ?? "").trim();
  const status = String(req.query.status ?? "").trim();

  const where: any = {};
  if (search) where.title = { contains: search };
  if (status) where.status = status;

  const [total, exams] = await Promise.all([
    prisma.exam.count({ where }),
    prisma.exam.findMany({
      where,
      include: { createdBy: true, _count: { select: { questions: true } } },
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ]);

  sendResponse(res, 200, exams.map(publicExam), null, {
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage) || 1,
  });
});

export const createExam = asyncHandler(async (req: Request, res: Response) => {
  const { title, description, category, durationMinutes, passingScorePercent, allowMultipleAttempts } = req.body ?? {};
  if (!title?.trim()) {
    sendError(res, 422, "Uzuza umutwe w'ikizamini.");
    return;
  }
  const exam = await prisma.exam.create({
    data: {
      title: title.trim(),
      description: description ? String(description) : "",
      category: category ? String(category) : "",
      durationMinutes: durationMinutes ? Math.max(1, Number(durationMinutes)) : null,
      passingScorePercent: passingScorePercent ? Math.min(100, Math.max(0, Number(passingScorePercent))) : 60,
      allowMultipleAttempts: Boolean(allowMultipleAttempts),
      status: "DRAFT",
      createdById: req.user!.id,
    },
    include: { createdBy: true, _count: { select: { questions: true } } },
  });
  sendResponse(res, 201, publicExam(exam), "Ikizamini cyongewe (umushinga).");
});

export const updateExam = asyncHandler(async (req: Request, res: Response) => {
  const exam = await prisma.exam.findUnique({ where: { id: req.params.id } });
  if (!exam) {
    sendError(res, 404, "Iki kizamini ntikiboneka.");
    return;
  }
  const { title, description, category, durationMinutes, passingScorePercent, allowMultipleAttempts } = req.body ?? {};

  const data: any = {};
  if (title !== undefined) data.title = String(title).trim();
  if (description !== undefined) data.description = String(description);
  if (category !== undefined) data.category = String(category);
  if (durationMinutes !== undefined) data.durationMinutes = durationMinutes ? Math.max(1, Number(durationMinutes)) : null;
  if (passingScorePercent !== undefined) data.passingScorePercent = Math.min(100, Math.max(0, Number(passingScorePercent)));
  if (allowMultipleAttempts !== undefined) data.allowMultipleAttempts = Boolean(allowMultipleAttempts);
  // Publishing/unpublishing is a separate, dedicated permission (exam.publish)
  // — see setExamStatus below — so it deliberately doesn't live here even
  // though the request shape would allow it. Someone granted only
  // "edit exam content" can no longer silently publish a half-finished exam,
  // and someone granted only "publish exams" can't quietly rewrite content.

  const updated = await prisma.exam.update({
    where: { id: exam.id },
    data,
    include: { createdBy: true, _count: { select: { questions: true } } },
  });
  sendResponse(res, 200, publicExam(updated), "Bikawe.");
});

/** Dedicated publish/unpublish action — gated by exam.publish, independent
 * of exam.update, so the two capabilities can be granted separately. */
export const setExamStatus = asyncHandler(async (req: Request, res: Response) => {
  const exam = await prisma.exam.findUnique({ where: { id: req.params.id } });
  if (!exam) {
    sendError(res, 404, "Iki kizamini ntikiboneka.");
    return;
  }
  const publish = req.params.action === "publish";

  if (publish) {
    const questionCount = await prisma.question.count({ where: { examId: exam.id } });
    if (questionCount === 0) {
      sendError(res, 422, "Ntushobora gutangaza ikizamini kidafite ikibazo na kimwe.");
      return;
    }
  }

  const updated = await prisma.exam.update({
    where: { id: exam.id },
    data: { status: publish ? "PUBLISHED" : "DRAFT", publishedAt: publish ? new Date() : null },
    include: { createdBy: true, _count: { select: { questions: true } } },
  });
  sendResponse(res, 200, publicExam(updated), publish ? "Ikizamini cyatangajwe." : "Ikizamini cyakuwe ku mugaragaro.");
});

export const deleteExam = asyncHandler(async (req: Request, res: Response) => {
  const exam = await prisma.exam.findUnique({ where: { id: req.params.id } });
  if (!exam) {
    sendError(res, 404, "Iki kizamini ntikiboneka.");
    return;
  }
  await prisma.exam.delete({ where: { id: exam.id } }); // cascades to questions/options/attempts/answers
  sendResponse(res, 200, null, "Ikizamini cyasibwe.");
});

// ===================== Admin: question builder =====================
// Full question detail (including correct answers) — admin-only, never
// served to a student taking the exam (see getExamForTaking below).

export const getExamWithQuestions = asyncHandler(async (req: Request, res: Response) => {
  const exam = await prisma.exam.findUnique({
    where: { id: req.params.id },
    include: {
      createdBy: true,
      _count: { select: { questions: true } },
      questions: { include: { options: { orderBy: { order: "asc" } } }, orderBy: { order: "asc" } },
    },
  });
  if (!exam) {
    sendError(res, 404, "Iki kizamini ntikiboneka.");
    return;
  }
  sendResponse(res, 200, { ...publicExam(exam), questions: exam.questions });
});

export const addQuestion = asyncHandler(async (req: Request, res: Response) => {
  const exam = await prisma.exam.findUnique({ where: { id: req.params.id } });
  if (!exam) {
    sendError(res, 404, "Iki kizamini ntikiboneka.");
    return;
  }
  const { type, prompt, points, options } = req.body ?? {};
  const normalizedType = String(type ?? "").toUpperCase();

  if (!QUESTION_TYPES.has(normalizedType)) {
    sendError(res, 422, "Ubwoko bw'ikibazo bugomba kuba MULTIPLE_CHOICE cyangwa FILL_BLANK.");
    return;
  }
  if (!prompt?.trim()) {
    sendError(res, 422, "Andika ikibazo.");
    return;
  }
  if (!Array.isArray(options) || options.length === 0) {
    sendError(
      res,
      422,
      normalizedType === "MULTIPLE_CHOICE"
        ? "Ongeramo byibura ubusubizo bubiri, hitamo n'ubw'ukuri."
        : "Andika byibura igisubizo kimwe cy'ukuri."
    );
    return;
  }
  if (normalizedType === "MULTIPLE_CHOICE") {
    if (options.length < 2) {
      sendError(res, 422, "Ikibazo cy'amahitamo kigomba kuba gifite byibura amahitamo abiri.");
      return;
    }
    if (!options.some((o: any) => o.isCorrect)) {
      sendError(res, 422, "Hitamo igisubizo kimwe nibura nk'icy'ukuri.");
      return;
    }
  }

  const maxOrder = await prisma.question.aggregate({ where: { examId: exam.id }, _max: { order: true } });

  const question = await prisma.question.create({
    data: {
      examId: exam.id,
      type: normalizedType,
      prompt: prompt.trim(),
      points: points ? Math.max(1, Number(points)) : 1,
      order: (maxOrder._max.order ?? -1) + 1,
      options: {
        create:
          normalizedType === "MULTIPLE_CHOICE"
            ? options.map((o: any, i: number) => ({ text: String(o.text ?? "").trim(), isCorrect: Boolean(o.isCorrect), order: i }))
            : options.map((o: any, i: number) => ({ text: String(o.text ?? o).trim(), isCorrect: true, order: i })),
      },
    },
    include: { options: { orderBy: { order: "asc" } } },
  });

  sendResponse(res, 201, question, "Ikibazo cyongewe.");
});

export const updateQuestion = asyncHandler(async (req: Request, res: Response) => {
  const question = await prisma.question.findUnique({ where: { id: req.params.questionId } });
  if (!question) {
    sendError(res, 404, "Iki kibazo ntikiboneka.");
    return;
  }
  const { prompt, points, options } = req.body ?? {};

  const data: any = {};
  if (prompt !== undefined) data.prompt = String(prompt).trim();
  if (points !== undefined) data.points = Math.max(1, Number(points));

  await prisma.$transaction(async (tx) => {
    if (Object.keys(data).length > 0) {
      await tx.question.update({ where: { id: question.id }, data });
    }
    if (Array.isArray(options)) {
      await tx.questionOption.deleteMany({ where: { questionId: question.id } });
      await tx.questionOption.createMany({
        data: options.map((o: any, i: number) => ({
          questionId: question.id,
          text: String(o.text ?? o).trim(),
          isCorrect: question.type === "FILL_BLANK" ? true : Boolean(o.isCorrect),
          order: i,
        })),
      });
    }
  });

  const updated = await prisma.question.findUnique({
    where: { id: question.id },
    include: { options: { orderBy: { order: "asc" } } },
  });
  sendResponse(res, 200, updated, "Bikawe.");
});

export const deleteQuestion = asyncHandler(async (req: Request, res: Response) => {
  const question = await prisma.question.findUnique({ where: { id: req.params.questionId } });
  if (!question) {
    sendError(res, 404, "Iki kibazo ntikiboneka.");
    return;
  }
  await prisma.question.delete({ where: { id: question.id } });
  sendResponse(res, 200, null, "Ikibazo cyasibwe.");
});

export const reorderQuestions = asyncHandler(async (req: Request, res: Response) => {
  const { orderedIds } = req.body ?? {};
  if (!Array.isArray(orderedIds)) {
    sendError(res, 422, "Urutonde rw'ibibazo ntirwatanzwe neza.");
    return;
  }
  await prisma.$transaction(
    orderedIds.map((id: string, index: number) => prisma.question.update({ where: { id }, data: { order: index } }))
  );
  sendResponse(res, 200, null, "Urutonde rwabitswe.");
});

// ===================== Admin: results =====================

export const listAttempts = asyncHandler(async (req: Request, res: Response) => {
  const exam = await prisma.exam.findUnique({ where: { id: req.params.id } });
  if (!exam) {
    sendError(res, 404, "Iki kizamini ntikiboneka.");
    return;
  }
  const attempts = await prisma.examAttempt.findMany({
    where: { examId: exam.id, status: "SUBMITTED" },
    include: { user: true },
    orderBy: { submittedAt: "desc" },
  });
  sendResponse(
    res,
    200,
    attempts.map((a) => ({
      id: a.id,
      userId: a.userId,
      userName: a.user.fullName,
      userEmail: a.user.email,
      scorePercent: a.scorePercent,
      earnedPoints: a.earnedPoints,
      totalPoints: a.totalPoints,
      passed: a.passed,
      startedAt: a.startedAt,
      submittedAt: a.submittedAt,
    }))
  );
});

// ===================== Student: browsing + taking =====================

export const listPublished = asyncHandler(async (req: Request, res: Response) => {
  const exams = await prisma.exam.findMany({
    where: { status: "PUBLISHED" },
    include: {
      _count: { select: { questions: true } },
      attempts: { where: { userId: req.user!.id }, orderBy: { startedAt: "desc" }, take: 1 },
    },
    orderBy: { publishedAt: "desc" },
  });

  sendResponse(
    res,
    200,
    exams.map((e) => {
      const lastAttempt = e.attempts[0];
      return {
        ...publicExam(e),
        myLastAttempt: lastAttempt
          ? { id: lastAttempt.id, status: lastAttempt.status, scorePercent: lastAttempt.scorePercent, passed: lastAttempt.passed }
          : null,
        canAttempt: !lastAttempt || lastAttempt.status !== "SUBMITTED" || e.allowMultipleAttempts,
      };
    })
  );
});

/** Questions WITHOUT correct-answer info — this is what a student sees while taking the exam. */
export const getExamForTaking = asyncHandler(async (req: Request, res: Response) => {
  const exam = await prisma.exam.findUnique({
    where: { id: req.params.id },
    include: { questions: { include: { options: true }, orderBy: { order: "asc" } } },
  });
  if (!exam || exam.status !== "PUBLISHED") {
    sendError(res, 404, "Iki kizamini ntikiboneka.");
    return;
  }

  sendResponse(res, 200, {
    ...publicExam(exam),
    questions: exam.questions.map((q) => ({
      id: q.id,
      type: q.type,
      prompt: q.prompt,
      points: q.points,
      order: q.order,
      options: q.type === "MULTIPLE_CHOICE" ? q.options.map((o) => ({ id: o.id, text: o.text })) : undefined,
    })),
  });
});

export const startAttempt = asyncHandler(async (req: Request, res: Response) => {
  const exam = await prisma.exam.findUnique({ where: { id: req.params.id } });
  if (!exam || exam.status !== "PUBLISHED") {
    sendError(res, 404, "Iki kizamini ntikiboneka.");
    return;
  }

  const existing = await prisma.examAttempt.findFirst({
    where: { examId: exam.id, userId: req.user!.id },
    orderBy: { startedAt: "desc" },
  });
  if (existing?.status === "IN_PROGRESS") {
    sendResponse(res, 200, { attemptId: existing.id, startedAt: existing.startedAt }, "Ufite ikizamini utarangiza.");
    return;
  }
  if (existing?.status === "SUBMITTED" && !exam.allowMultipleAttempts) {
    sendError(res, 422, "Wamaze gukora iki kizamini — ntikwemerewe kongera.");
    return;
  }

  const attempt = await prisma.examAttempt.create({ data: { examId: exam.id, userId: req.user!.id } });
  sendResponse(res, 201, { attemptId: attempt.id, startedAt: attempt.startedAt });
});

export const submitAttempt = asyncHandler(async (req: Request, res: Response) => {
  const attempt = await prisma.examAttempt.findUnique({
    where: { id: req.params.attemptId },
    include: { exam: { include: { questions: { include: { options: true } } } } },
  });
  if (!attempt || attempt.userId !== req.user!.id) {
    sendError(res, 404, "Iki gerageza ntikiboneka.");
    return;
  }
  if (attempt.status === "SUBMITTED") {
    sendError(res, 422, "Iki kizamini wamaze kugitanga.");
    return;
  }

  const { answers } = req.body ?? {}; // [{ questionId, selectedOptionId?, textAnswer? }]
  if (!Array.isArray(answers)) {
    sendError(res, 422, "Ibisubizo ntibyatanzwe neza.");
    return;
  }
  const answerByQuestion = new Map(answers.map((a: any) => [a.questionId, a]));

  let totalPoints = 0;
  let earnedPoints = 0;
  const answerRows: any[] = [];

  for (const q of attempt.exam.questions) {
    totalPoints += q.points;
    const given: any = answerByQuestion.get(q.id);
    let isCorrect = false;
    let selectedOptionId: string | null = null;
    let textAnswer: string | null = null;

    if (q.type === "MULTIPLE_CHOICE") {
      selectedOptionId = given?.selectedOptionId ? String(given.selectedOptionId) : null;
      const chosen = q.options.find((o) => o.id === selectedOptionId);
      isCorrect = Boolean(chosen?.isCorrect);
    } else {
      // FILL_BLANK — real deterministic grading: trim + lowercase match
      // against any accepted answer stored as a QuestionOption row.
      textAnswer = given?.textAnswer ? String(given.textAnswer) : null;
      const normalized = (textAnswer ?? "").trim().toLowerCase();
      isCorrect = normalized.length > 0 && q.options.some((o) => o.text.trim().toLowerCase() === normalized);
    }

    const pointsAwarded = isCorrect ? q.points : 0;
    earnedPoints += pointsAwarded;

    answerRows.push({ attemptId: attempt.id, questionId: q.id, selectedOptionId, textAnswer, isCorrect, pointsAwarded });
  }

  const scorePercent = totalPoints > 0 ? Math.round((earnedPoints / totalPoints) * 1000) / 10 : 0;
  const passed = scorePercent >= attempt.exam.passingScorePercent;

  await prisma.$transaction([
    prisma.examAnswer.deleteMany({ where: { attemptId: attempt.id } }),
    prisma.examAnswer.createMany({ data: answerRows }),
    prisma.examAttempt.update({
      where: { id: attempt.id },
      data: { status: "SUBMITTED", submittedAt: new Date(), totalPoints, earnedPoints, scorePercent, passed },
    }),
  ]);

  sendResponse(res, 200, { scorePercent, earnedPoints, totalPoints, passed }, "Ikizamini cyoherejwe.");
});

export const getAttemptResult = asyncHandler(async (req: Request, res: Response) => {
  const attempt = await prisma.examAttempt.findUnique({
    where: { id: req.params.attemptId },
    include: { exam: true, answers: { include: { question: { include: { options: true } }, selectedOption: true } } },
  });
  if (!attempt || attempt.userId !== req.user!.id) {
    sendError(res, 404, "Iki gerageza ntikiboneka.");
    return;
  }
  if (attempt.status !== "SUBMITTED") {
    sendError(res, 422, "Iki kizamini ntikirarangira.");
    return;
  }

  sendResponse(res, 200, {
    examTitle: attempt.exam.title,
    scorePercent: attempt.scorePercent,
    earnedPoints: attempt.earnedPoints,
    totalPoints: attempt.totalPoints,
    passed: attempt.passed,
    submittedAt: attempt.submittedAt,
    answers: attempt.answers.map((a) => ({
      questionId: a.questionId,
      prompt: a.question.prompt,
      type: a.question.type,
      points: a.question.points,
      isCorrect: a.isCorrect,
      pointsAwarded: a.pointsAwarded,
      yourTextAnswer: a.textAnswer,
      yourSelectedOptionText: a.selectedOption?.text,
      correctOptions: a.question.options.filter((o) => o.isCorrect).map((o) => o.text),
    })),
  });
});
