import { randomUUID } from 'crypto';

export const SHIPPING_EXPENSE_CATEGORIES = {
    POSTAGE: 'Shipping - Postage',
    MATERIALS: 'Shipping - Materials',
};

export const MANAPOOL_AUTO_SHIPPING_THRESHOLD = 45;
export const MANAPOOL_AUTO_SHIPPING_AMOUNT = 5;

/**
 * Inserts an expense entry row.
 * Returns the created expense id for convenience.
 */
export const insertExpenseEntry = (db, {
    amount,
    category = null,
    description,
    paymentMethod = null,
    incurredOn = new Date().toISOString(),
    linkedInventoryId = null,
    notes = null,
} = {}) => {
    const normalizedAmount = Number(amount);
    if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
        return Promise.resolve(null);
    }
    const expenseId = randomUUID();
    const sql = `
        INSERT INTO expense_entries (id, incurredOn, amount, category, description, paymentMethod, linkedInventoryId, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    return new Promise((resolve, reject) => {
        db.run(sql, [
            expenseId,
            incurredOn,
            Number(normalizedAmount.toFixed(2)),
            category,
            description,
            paymentMethod,
            linkedInventoryId,
            notes,
        ], (err) => {
            if (err) {
                return reject(err);
            }
            resolve(expenseId);
        });
    });
};

export const recordShippingExpense = (db, payload = {}) => {
    return insertExpenseEntry(db, {
        paymentMethod: 'Auto',
        ...payload,
        category: payload.category || SHIPPING_EXPENSE_CATEGORIES.POSTAGE,
    });
};
