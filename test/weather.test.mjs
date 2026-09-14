import test from 'node:test'
import assert from 'node:assert/strict'
import { WeatherSystem } from '../src/world/weather.js'

test('WeatherSystem calculates calm state when all threads are healthy', () => {
  const settings = { get: (k) => k === 'gitWeather' ? true : null }
  const weather = new WeatherSystem(settings)

  weather.updateStatus([
    { id: '1', running: true, hasError: false, prState: 'open' },
    { id: '2', running: false, hasError: false, prState: '' },
  ])

  assert.equal(weather.weatherType, 'calm')
  assert.equal(weather.targetStorm, 0)
  assert.equal(weather.targetAurora, 0)
})

test('WeatherSystem triggers storm state when any thread has error or blocked', () => {
  const settings = { get: (k) => k === 'gitWeather' ? true : null }
  const weather = new WeatherSystem(settings)

  weather.updateStatus([
    { id: '1', running: false, hasError: true, prState: 'open' },
    { id: '2', running: true, hasError: false, prState: '' },
  ])

  assert.equal(weather.weatherType, 'storm')
  assert.ok(weather.targetStorm > 0)
  assert.equal(weather.targetAurora, 0)

  // Test damp transition in tick
  weather.tick(0.5)
  assert.ok(weather.stormIntensity > 0)
})

test('WeatherSystem triggers aurora state when a pull request is merged', () => {
  const settings = { get: (k) => k === 'gitWeather' ? true : null }
  const weather = new WeatherSystem(settings)

  weather.updateStatus([
    { id: '1', running: false, hasError: false, prState: 'merged' },
    { id: '2', running: true, hasError: false, prState: '' },
  ])

  assert.equal(weather.weatherType, 'aurora')
  assert.ok(weather.targetAurora > 0)
  assert.equal(weather.targetStorm, 0)

  weather.tick(0.5)
  assert.ok(weather.auroraIntensity > 0)
})

test('WeatherSystem respects gitWeather setting being disabled', () => {
  const settings = { get: (k) => k === 'gitWeather' ? false : null }
  const weather = new WeatherSystem(settings)

  weather.updateStatus([
    { id: '1', running: false, hasError: true, prState: 'merged' },
  ])

  assert.equal(weather.weatherType, 'calm')
  assert.equal(weather.targetStorm, 0)
  assert.equal(weather.targetAurora, 0)
})
