export async function getWeather(city: string, signal?: AbortSignal) {
  signal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
    : AbortSignal.timeout(15000);
  const geoResponse = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`,
    { signal },
  );

  if (!geoResponse.ok) {
    throw new Error("City lookup failed.");
  }

  const geoData = await geoResponse.json();

  if (!geoData.results || geoData.results.length === 0) {
    return `Could not find the city ${city}.`;
  }

  const location = geoData.results[0];

  const weatherResponse = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${location.latitude}&longitude=${location.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&timezone=auto`,
    { signal },
  );

  if (!weatherResponse.ok) {
    throw new Error("Weather lookup failed.");
  }

  const weatherData = await weatherResponse.json();

  return JSON.stringify({
    city: location.name,
    country: location.country,
    temperature: weatherData.current.temperature_2m,
    apparent_temperature: weatherData.current.apparent_temperature,
    humidity: weatherData.current.relative_humidity_2m,
    precipitation: weatherData.current.precipitation,
    wind_speed: weatherData.current.wind_speed_10m,
    weather_code: weatherData.current.weather_code,
  });
}
