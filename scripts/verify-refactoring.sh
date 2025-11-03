#!/bin/bash
set -e

echo "🔨 Building..."
npm run build

echo "🧪 Running module tests..."
npm test tests/modules

echo "🧪 Running all tests..."
npm test

echo "✅ All checks passed!"
