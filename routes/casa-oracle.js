/**
 * CASA Environmental Oracle API Endpoint
 * 
 * POST /precog/environmental_home_risk
 * 
 * Handles conversational homeowner Q&A about environmental risks.
 * 
 * @module casa-oracle-endpoint
 */

const express = require('express');
const EnvironmentalHomeRiskOracle = require('../precogs/environmental/oracles/environmental_home_risk');

const router = express.Router();

// Rate limiting (simple in-memory implementation)
const requestCounts = new Map();
const RATE_LIMIT = 100; // requests per hour
const RATE_WINDOW = 60 * 60 * 1000; // 1 hour in ms

/**
 * POST /precog/environmental_home_risk
 * 
 * CASA Contract:
 * 
 * Request:
 * {
 *   "question": "Should I worry about mold?",
 *   "zip": "33907",
 *   "home_context": {
 *     "siding_material": "vinyl",
 *     "roof_age": 15,
 *     "structure_type": "single_family"
 *   }
 * }
 * 
 * Response:
 * {
 *   "assessment": "Your area has higher-than-average mold risk...",
 *   "risk_score": 0.82,
 *   "risk_level": "high",
 *   "causes": [...],
 *   "steps": [...],
 *   "follow_up": [...],
 *   "data_summary": {...}
 * }
 * 
 * Error Response:
 * {
 *   "error": "insufficient_data|location_invalid|question_unclear|rate_limit|internal_error",
 *   "message": "Human-readable error message",
 *   ...
 * }
 */
router.post('/precog/environmental_home_risk', async (req, res) => {
    const startTime = Date.now();

    try {
        // Rate limiting check
        const clientId = req.ip || 'unknown';
        const now = Date.now();

        if (!requestCounts.has(clientId)) {
            requestCounts.set(clientId, []);
        }

        const requests = requestCounts.get(clientId);
        const recentRequests = requests.filter(time => now - time < RATE_WINDOW);

        if (recentRequests.length >= RATE_LIMIT) {
            return res.status(429).json({
                error: 'rate_limit',
                message: 'Too many requests. Please try again later.',
                assessment: null,
                risk_score: null,
                risk_level: null,
                causes: [],
                steps: [],
                follow_up: [],
                data_summary: null
            });
        }

        recentRequests.push(now);
        requestCounts.set(clientId, recentRequests);

        // Validate request body
        const { question, zip, home_context } = req.body;

        if (!question || typeof question !== 'string') {
            return res.status(400).json({
                error: 'question_unclear',
                message: 'Please provide a question.',
                assessment: null,
                risk_score: null,
                risk_level: null,
                causes: [],
                steps: [],
                follow_up: [],
                data_summary: null
            });
        }

        if (!zip || typeof zip !== 'string') {
            return res.status(400).json({
                error: 'location_invalid',
                message: 'Please provide a ZIP code.',
                assessment: null,
                risk_score: null,
                risk_level: null,
                causes: [],
                steps: [],
                follow_up: [],
                data_summary: null
            });
        }

        // Create oracle instance
        const oracle = new EnvironmentalHomeRiskOracle(req.app.locals.graphClient);

        // Process request
        const response = await oracle.ask({
            question,
            zip,
            home_context: home_context || {}
        });

        // Log request
        const duration = Date.now() - startTime;
        console.log(`[casa-oracle] ${zip} - "${question.substring(0, 50)}..." - ${duration}ms`);

        // Return response
        if (response.error) {
            const statusCode = response.error === 'rate_limit' ? 429 :
                response.error === 'location_invalid' ? 400 :
                    response.error === 'question_unclear' ? 400 :
                        response.error === 'insufficient_data' ? 404 : 500;

            return res.status(statusCode).json(response);
        }

        return res.status(200).json(response);

    } catch (error) {
        console.error('[casa-oracle] Error:', error);

        return res.status(500).json({
            error: 'internal_error',
            message: 'Something went wrong. Please try again.',
            assessment: null,
            risk_score: null,
            risk_level: null,
            causes: [],
            steps: [],
            follow_up: [],
            data_summary: null
        });
    }
});

/**
 * GET /precog/environmental_home_risk/health
 * 
 * Health check endpoint
 */
router.get('/precog/environmental_home_risk/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        service: 'environmental_home_risk_oracle',
        version: '1.0.0',
        timestamp: new Date().toISOString()
    });
});

module.exports = router;
