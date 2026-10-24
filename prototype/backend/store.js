const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function fail(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

const cents = (value) => Math.round(Number(value) * 100);
const dateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
});
function localDate(value) {
    const parts = Object.fromEntries(dateFormatter.formatToParts(new Date(value)).map(p => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Local demo observations only. Savings are estimates, not completed orders. */
class DemoStore {
    constructor(dataDir, now = () => Date.now()) {
        this.now = now;
        this.file = path.join(dataDir, 'events.json');
        fs.mkdirSync(dataDir, { recursive: true });
        try {
            this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (this.data.version !== 1 || !this.data.quotes || typeof this.data.quotes !== 'object'
                || Array.isArray(this.data.quotes) || !Array.isArray(this.data.events)) {
                throw new Error('Invalid demo store format');
            }
            for (const event of this.data.events) {
                if (!event || !['shown', 'accepted', 'rejected', 'reverted'].includes(event.type)
                    || !Number.isFinite(event.saved) || !Array.isArray(event.itemNames)
                    || !Number.isFinite(Date.parse(event.createdAt)) || !this.data.quotes[event.recommendationId]) {
                    throw new Error('Invalid demo event');
                }
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw new Error(`无法读取演示统计文件，原文件已保留：${error.message}`);
            }
            this.data = { version: 1, quotes: {}, events: [] };
        }
    }

    commit(next) {
        const temporaryFile = `${this.file}.${randomUUID()}.tmp`;
        try {
            fs.writeFileSync(temporaryFile, JSON.stringify(next, null, 2), 'utf8');
            fs.renameSync(temporaryFile, this.file);
            this.data = next;
        } catch (error) {
            try { fs.unlinkSync(temporaryFile); } catch (_) { /* Only remove our incomplete write. */ }
            throw fail(503, '统计写入失败，请重试；本次操作未被记录');
        }
    }

    /** Clear all demo events and expired quotes; used by the dashboard reset entry. */
    reset() {
        this.commit({ version: 1, quotes: {}, events: [] });
    }

    /**
     * Local demo preference weights per item category, derived only from this store's events.
     * Accepted savings count most, minimum-order adoptions count less, rejections and reversals
     * count against. Clamped to [-3, 3]; old events without categories are ignored.
     */
    categoryAffinity() {
        const score = new Map();
        for (const event of this.data.events) {
            const weight = event.type === 'accepted' ? (event.kind === 'minimum-order' ? 0.5 : 1)
                : event.type === 'reverted' ? -1.5 : event.type === 'rejected' ? -0.75 : 0;
            if (!weight || !Array.isArray(event.itemCategories)) continue;
            for (const category of event.itemCategories) {
                score.set(category, Math.max(-3, Math.min(3, (score.get(category) || 0) + weight)));
            }
        }
        return score;
    }

    addQuotes(suggestions, input, promotionSignature) {
        if (!suggestions.length) return [];
        const now = this.now();
        const groupId = randomUUID();
        const next = structuredClone(this.data);
        const observedIds = new Set(next.events.map(event => event.recommendationId));
        for (const [quoteId, quote] of Object.entries(next.quotes)) {
            if (!observedIds.has(quoteId) && quote.expiresAt < now - 86400000) delete next.quotes[quoteId];
        }
        const quotes = suggestions.map(suggestion => {
            const id = randomUUID();
            const quote = {
                id, groupId, createdAt: new Date(now).toISOString(), expiresAt: now + 5 * 60 * 1000,
                suggestion: structuredClone(suggestion), input: structuredClone(input), promotionSignature
            };
            next.quotes[id] = quote;
            return quote;
        });
        this.commit(next);
        return quotes.map(quote => this.publicSuggestion(quote));
    }

    // Kept for callers storing a single quote and for older stored quote shapes.
    addQuote(suggestion, input, promotionSignature) {
        return this.addQuotes([suggestion], input, promotionSignature)[0].id;
    }

    publicSuggestion(quote) {
        return { ...structuredClone(quote.suggestion), kind: quote.suggestion.kind || 'saving',
            paymentChange: quote.suggestion.paymentChange ?? (cents(quote.suggestion.newTotal) - cents(quote.suggestion.currentTotal)) / 100,
            id: quote.id, groupId: quote.groupId || quote.id,
            createdAt: quote.createdAt, expiresAt: quote.expiresAt };
    }

    publicEvent(event) {
        const suggestion = this.data.quotes[event.recommendationId]?.suggestion || {};
        return { ...event, kind: event.kind || 'saving',
            newTotal: event.newTotal ?? suggestion.newTotal,
            additionCost: event.additionCost ?? suggestion.additionCost,
            paymentChange: event.paymentChange ?? suggestion.paymentChange
                ?? (cents(suggestion.newTotal) - cents(suggestion.currentTotal)) / 100 };
    }

    currentDecision(id) {
        const events = this.data.events.filter(event => event.recommendationId === id);
        if (events.some(event => event.type === 'reverted')) return 'reverted';
        return events.find(event => event.type === 'accepted' || event.type === 'rejected')?.type || null;
    }

    getSuggestion(id) {
        const quote = this.data.quotes[id];
        if (!quote) throw fail(404, '未找到建议，请重新计算');
        return { suggestion: this.publicSuggestion(quote), decision: this.currentDecision(id),
            shown: this.data.events.some(event => event.recommendationId === id && event.type === 'shown'),
            groupId: quote.groupId || quote.id, expiresAt: quote.expiresAt };
    }

    record(recommendationId, type, validateAcceptance) {
        const quote = this.data.quotes[recommendationId];
        if (!quote) throw fail(404, '未找到建议，请重新计算');
        const previous = this.data.events.filter(event => event.recommendationId === recommendationId);
        const same = previous.find(event => event.type === type);
        if (same) return { event: this.publicEvent(same), duplicate: true, currentDecision: this.currentDecision(recommendationId) };
        if (type === 'reverted') {
            if (!previous.some(event => event.type === 'accepted')) throw fail(409, '只能撤销已采纳的建议');
        } else {
            if (previous.some(event => event.type === 'accepted' || event.type === 'rejected')) {
                throw fail(409, '该建议已经处理，请重新计算');
            }
            if ((type === 'shown' || type === 'accepted') && this.now() >= quote.expiresAt) {
                throw fail(409, '建议已过期，请重新计算');
            }
            if (type !== 'shown' && !previous.some(event => event.type === 'shown')) {
                throw fail(409, '请先展示建议，再提交选择');
            }
            if (type === 'accepted') {
                const groupId = quote.groupId || quote.id;
                const groupUsed = this.data.events.some(event => event.type === 'accepted'
                    && (this.data.quotes[event.recommendationId].groupId || event.recommendationId) === groupId);
                if (groupUsed) throw fail(409, '该批方案已有采纳记录，请重新计算');
                validateAcceptance(quote);
            }
        }
        const items = quote.suggestion.items || [quote.suggestion.item];
        const kind = quote.suggestion.kind || 'saving';
        const event = {
            id: randomUUID(), recommendationId, type, createdAt: new Date(this.now()).toISOString(),
            kind, newTotal: quote.suggestion.newTotal, additionCost: quote.suggestion.additionCost,
            paymentChange: quote.suggestion.paymentChange ?? (cents(quote.suggestion.newTotal) - cents(quote.suggestion.currentTotal)) / 100,
            itemNames: items.map(item => `${item.name}${item.quantity > 1 ? ` ×${item.quantity}` : ''}`),
            itemCategories: [...new Set(items.map(item => item.category).filter(Boolean))],
            saved: kind === 'minimum-order' ? 0 : type === 'accepted' ? cents(quote.suggestion.netSaving) / 100
                : type === 'reverted' ? -cents(quote.suggestion.netSaving) / 100 : 0
        };
        const next = structuredClone(this.data);
        next.events.push(event);
        this.commit(next);
        return { event, duplicate: false, currentDecision: this.currentDecision(recommendationId) };
    }

    history({ type = 'all', limit = 20, before } = {}) {
        if (!['all', 'accepted', 'rejected', 'reverted'].includes(type)
            || !Number.isInteger(limit) || limit < 1 || limit > 100) throw fail(400, '历史筛选类型或条数无效');
        const events = this.data.events;
        const beforeIndex = before === undefined ? events.length : events.findIndex(event => event.id === before);
        if (beforeIndex < 0) throw fail(400, '历史分页游标无效');
        const filter = event => event.type !== 'shown' && (type === 'all' || event.type === type);
        const filtered = events.slice(0, beforeIndex).filter(filter).reverse();
        const revertedIds = new Set(events.filter(event => event.type === 'reverted').map(event => event.recommendationId));
        const page = filtered.slice(0, limit).map(event => ({ ...this.publicEvent(event),
            reverted: event.type === 'accepted' && revertedIds.has(event.recommendationId) }));
        return { events: page, total: events.filter(filter).length,
            nextCursor: filtered.length > limit ? page[page.length - 1].id : null };
    }

    dashboard(metrics) {
        const events = this.data.events;
        const revertedIds = new Set(events.filter(event => event.type === 'reverted').map(event => event.recommendationId));
        const originalAccepted = events.filter(event => event.type === 'accepted');
        const accepted = originalAccepted.filter(event => !revertedIds.has(event.recommendationId));
        const minimumOrderAcceptedCount = accepted.filter(event => event.kind === 'minimum-order').length;
        const rejectedCount = events.filter(event => event.type === 'rejected').length;
        const shownCount = events.filter(event => event.type === 'shown').length;
        const totalSaved = accepted.reduce((sum, event) => sum + cents(event.saved), 0) / 100;
        const decisions = accepted.length + rejectedCount;
        const today = localDate(this.now());
        const midnight = Date.parse(`${today}T00:00:00+08:00`);
        const trend = Array.from({ length: 7 }, (_, i) => {
            const date = localDate(midnight - (6 - i) * 86400000);
            const dayEvents = accepted.filter(event => localDate(event.createdAt) === date);
            return {
                date, saved: dayEvents.reduce((sum, event) => sum + cents(event.saved), 0) / 100,
                acceptedCount: dayEvents.length
            };
        });
        return {
            source: 'local-demo', updatedAt: new Date(this.now()).toISOString(),
            summary: {
                shownCount, acceptedCount: accepted.length, rejectedCount, revertedCount: revertedIds.size,
                minimumOrderAcceptedCount, savingAcceptedCount: accepted.length - minimumOrderAcceptedCount,
                pendingCount: shownCount - originalAccepted.length - rejectedCount, totalSaved,
                averageSaving: accepted.length ? totalSaved / accepted.length : 0,
                adoptionRate: decisions ? accepted.length / decisions : null
            },
            performance: {
                sampleCount: metrics.sampleCount,
                averageMs: metrics.avgCalcTime,
                p99Ms: metrics.p99CalcTime
            },
            trend, recentEvents: events.slice(-20).reverse().map(event => ({ ...this.publicEvent(event),
                reverted: event.type === 'accepted' && revertedIds.has(event.recommendationId) }))
        };
    }
}

module.exports = { DemoStore, fail, cents };
