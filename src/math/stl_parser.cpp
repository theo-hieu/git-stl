#include <cerrno>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <vector>

namespace {

constexpr int kInvalidStlErrorCode = -1;
constexpr std::uint32_t kBinaryStlHeaderBytes = 80;
constexpr std::uint32_t kTriangleCountBytes = 4;
constexpr std::uint32_t kBinaryStlPreambleBytes =
    kBinaryStlHeaderBytes + kTriangleCountBytes;
constexpr std::uint32_t kTriangleRecordBytes = 50;
constexpr std::uint32_t kNormalBytes = 12;
constexpr std::uint32_t kVertexBytes = 12;
constexpr std::uint32_t kAttributeBytes = 2;
constexpr std::uint32_t kVerticesPerTriangle = 3;
constexpr std::uint32_t kFloatsPerVertex = 3;
constexpr std::uint32_t kFloatsPerTriangle =
    kVerticesPerTriangle * kFloatsPerVertex;
constexpr std::size_t kMaxAsciiFloatTokenBytes = 64;
constexpr int kAsciiDetectionScanBytes = 4096;
constexpr float kNormalEpsilon = 1.0e-12f;

enum class StlFormat {
  Invalid,
  Binary,
  Ascii,
};

struct Vec3 {
  float x;
  float y;
  float z;
};

struct ParsedStlBuffers {
  float *positions;
  float *normals;
  int floatCount;
};

std::uint32_t readU32LE(const std::uint8_t *src) {
  return static_cast<std::uint32_t>(src[0]) |
         (static_cast<std::uint32_t>(src[1]) << 8U) |
         (static_cast<std::uint32_t>(src[2]) << 16U) |
         (static_cast<std::uint32_t>(src[3]) << 24U);
}

float readF32LE(const std::uint8_t *src) {
  const std::uint32_t bits = readU32LE(src);
  float value = 0.0f;
  std::memcpy(&value, &bits, sizeof(value));
  return value;
}

char lowerAscii(std::uint8_t byte) {
  if (byte >= 'A' && byte <= 'Z') {
    return static_cast<char>(byte + ('a' - 'A'));
  }

  return static_cast<char>(byte);
}

bool isAsciiWhitespace(std::uint8_t byte) {
  return byte == ' ' || byte == '\t' || byte == '\n' || byte == '\r' ||
         byte == '\f' || byte == '\v';
}

void skipAsciiWhitespace(const std::uint8_t *&cursor, const std::uint8_t *end) {
  while (cursor < end && isAsciiWhitespace(*cursor)) {
    ++cursor;
  }
}

void skipToLineEnd(const std::uint8_t *&cursor, const std::uint8_t *end) {
  while (cursor < end && *cursor != '\n' && *cursor != '\r') {
    ++cursor;
  }

  if (cursor < end && *cursor == '\r') {
    ++cursor;
  }
  if (cursor < end && *cursor == '\n') {
    ++cursor;
  }
}

bool matchesKeyword(const std::uint8_t *cursor, const std::uint8_t *end,
                    const char *keyword) {
  const std::uint8_t *scan = cursor;
  const char *word = keyword;

  while (*word != '\0') {
    if (scan >= end || lowerAscii(*scan) != *word) {
      return false;
    }

    ++scan;
    ++word;
  }

  return scan >= end || isAsciiWhitespace(*scan);
}

bool consumeKeyword(const std::uint8_t *&cursor, const std::uint8_t *end,
                    const char *keyword) {
  skipAsciiWhitespace(cursor, end);
  if (!matchesKeyword(cursor, end, keyword)) {
    return false;
  }

  while (*keyword != '\0') {
    ++cursor;
    ++keyword;
  }

  return true;
}

bool startsWithKeyword(const std::uint8_t *data, int length,
                       const char *keyword) {
  if (data == nullptr || length <= 0) {
    return false;
  }

  const std::uint8_t *cursor = data;
  const std::uint8_t *end = data + length;
  skipAsciiWhitespace(cursor, end);
  return matchesKeyword(cursor, end, keyword);
}

bool containsKeyword(const std::uint8_t *data, int length, const char *keyword,
                     int limit) {
  if (data == nullptr || length <= 0) {
    return false;
  }

  const int scanLimit = length < limit ? length : limit;
  for (int index = 0; index < scanLimit; ++index) {
    if (matchesKeyword(data + index, data + scanLimit, keyword)) {
      return true;
    }
  }

  return false;
}

bool hasTextualPrefix(const std::uint8_t *data, int length) {
  if (data == nullptr || length <= 0) {
    return false;
  }

  const int scanLimit = length < kAsciiDetectionScanBytes ? length : kAsciiDetectionScanBytes;
  for (int index = 0; index < scanLimit; ++index) {
    const std::uint8_t byte = data[index];
    if (byte == 0) {
      return false;
    }

    if (isAsciiWhitespace(byte)) {
      continue;
    }

    if (byte < 0x20 || byte > 0x7e) {
      return false;
    }
  }

  return true;
}

bool tryGetBinaryLayout(const std::uint8_t *data, int length,
                        std::uint32_t &triangleCount,
                        std::uint64_t &requiredBytes) {
  triangleCount = 0;
  requiredBytes = 0;

  if (data == nullptr || length < static_cast<int>(kBinaryStlPreambleBytes)) {
    return false;
  }

  triangleCount = readU32LE(data + kBinaryStlHeaderBytes);
  requiredBytes = static_cast<std::uint64_t>(kBinaryStlPreambleBytes) +
                  static_cast<std::uint64_t>(triangleCount) * kTriangleRecordBytes;

  return requiredBytes >= kBinaryStlPreambleBytes &&
         requiredBytes <= static_cast<std::uint64_t>(std::numeric_limits<int>::max());
}

StlFormat detectStlFormat(const std::uint8_t *data, int length) {
  if (data == nullptr || length < 0) {
    return StlFormat::Invalid;
  }

  std::uint32_t triangleCount = 0;
  std::uint64_t requiredBytes = 0;
  const bool hasBinaryLayout =
      tryGetBinaryLayout(data, length, triangleCount, requiredBytes) &&
      requiredBytes <= static_cast<std::uint64_t>(length);

  const bool startsWithSolid = startsWithKeyword(data, length, "solid");
  const bool looksTextual = startsWithSolid && hasTextualPrefix(data, length);
  const bool hasAsciiMarkers =
      looksTextual && containsKeyword(data, length, "facet", kAsciiDetectionScanBytes) &&
      containsKeyword(data, length, "vertex", kAsciiDetectionScanBytes);

  if (startsWithSolid) {
    if (hasBinaryLayout && requiredBytes == static_cast<std::uint64_t>(length)) {
      return StlFormat::Binary;
    }

    if (hasAsciiMarkers) {
      return StlFormat::Ascii;
    }

    if (hasBinaryLayout) {
      return StlFormat::Binary;
    }
  }

  if (hasBinaryLayout) {
    return StlFormat::Binary;
  }

  return StlFormat::Invalid;
}

Vec3 computeTriangleNormal(const Vec3 (&vertices)[kVerticesPerTriangle]) {
  const Vec3 edgeAB = {
      vertices[1].x - vertices[0].x,
      vertices[1].y - vertices[0].y,
      vertices[1].z - vertices[0].z,
  };
  const Vec3 edgeAC = {
      vertices[2].x - vertices[0].x,
      vertices[2].y - vertices[0].y,
      vertices[2].z - vertices[0].z,
  };

  return {
      edgeAB.y * edgeAC.z - edgeAB.z * edgeAC.y,
      edgeAB.z * edgeAC.x - edgeAB.x * edgeAC.z,
      edgeAB.x * edgeAC.y - edgeAB.y * edgeAC.x,
  };
}

Vec3 normalizeOrFallback(const Vec3 &candidate, const Vec3 &fallback) {
  const float candidateLengthSquared =
      candidate.x * candidate.x + candidate.y * candidate.y + candidate.z * candidate.z;
  if (candidateLengthSquared > kNormalEpsilon) {
    const float inverseLength = 1.0f / std::sqrt(candidateLengthSquared);
    return {candidate.x * inverseLength, candidate.y * inverseLength,
            candidate.z * inverseLength};
  }

  const float fallbackLengthSquared =
      fallback.x * fallback.x + fallback.y * fallback.y + fallback.z * fallback.z;
  if (fallbackLengthSquared > kNormalEpsilon) {
    const float inverseLength = 1.0f / std::sqrt(fallbackLengthSquared);
    return {fallback.x * inverseLength, fallback.y * inverseLength,
            fallback.z * inverseLength};
  }

  return {0.0f, 0.0f, 0.0f};
}

bool parseAsciiFloat(const std::uint8_t *&cursor, const std::uint8_t *end,
                     float &value) {
  skipAsciiWhitespace(cursor, end);
  if (cursor >= end) {
    return false;
  }

  char token[kMaxAsciiFloatTokenBytes];
  std::size_t tokenLength = 0;

  while (cursor < end && !isAsciiWhitespace(*cursor)) {
    if (tokenLength + 1 >= kMaxAsciiFloatTokenBytes) {
      return false;
    }

    token[tokenLength++] = static_cast<char>(*cursor);
    ++cursor;
  }

  if (tokenLength == 0) {
    return false;
  }

  token[tokenLength] = '\0';
  char *parseEnd = nullptr;
  errno = 0;
  const float parsed = std::strtof(token, &parseEnd);
  if (parseEnd == token || *parseEnd != '\0' || errno == ERANGE) {
    return false;
  }

  value = parsed;
  return true;
}

bool parseAsciiVec3(const std::uint8_t *&cursor, const std::uint8_t *end,
                    Vec3 &value) {
  return parseAsciiFloat(cursor, end, value.x) &&
         parseAsciiFloat(cursor, end, value.y) &&
         parseAsciiFloat(cursor, end, value.z);
}

ParsedStlBuffers *allocateParsedStlBuffers(int floatCount) {
  if (floatCount < 0) {
    return nullptr;
  }

  float *positions = nullptr;
  float *normals = nullptr;

  if (floatCount > 0) {
    positions = static_cast<float *>(
        std::malloc(static_cast<std::size_t>(floatCount) * sizeof(float)));
    if (positions == nullptr) {
      return nullptr;
    }

    normals = static_cast<float *>(
        std::malloc(static_cast<std::size_t>(floatCount) * sizeof(float)));
    if (normals == nullptr) {
      std::free(positions);
      return nullptr;
    }
  }

  auto *result = static_cast<ParsedStlBuffers *>(std::malloc(sizeof(ParsedStlBuffers)));
  if (result == nullptr) {
    std::free(normals);
    std::free(positions);
    return nullptr;
  }

  result->positions = positions;
  result->normals = normals;
  result->floatCount = floatCount;
  return result;
}

ParsedStlBuffers *parseBinaryStlInternal(const std::uint8_t *data, int length) {
  std::uint32_t triangleCount = 0;
  std::uint64_t requiredBytes = 0;
  if (!tryGetBinaryLayout(data, length, triangleCount, requiredBytes) ||
      requiredBytes > static_cast<std::uint64_t>(length)) {
    return nullptr;
  }

  const std::uint64_t floatCount64 =
      static_cast<std::uint64_t>(triangleCount) * kFloatsPerTriangle;
  if (floatCount64 > static_cast<std::uint64_t>(std::numeric_limits<int>::max())) {
    return nullptr;
  }

  auto *result = allocateParsedStlBuffers(static_cast<int>(floatCount64));
  if (result == nullptr) {
    return nullptr;
  }

  if (result->floatCount == 0) {
    return result;
  }

  const std::uint8_t *cursor = data + kBinaryStlPreambleBytes;
  int outIndex = 0;

  for (std::uint32_t triangleIndex = 0; triangleIndex < triangleCount; ++triangleIndex) {
    const Vec3 stlNormal = {
        readF32LE(cursor),
        readF32LE(cursor + 4),
        readF32LE(cursor + 8),
    };
    cursor += kNormalBytes;

    Vec3 vertices[kVerticesPerTriangle];
    for (std::uint32_t vertexIndex = 0; vertexIndex < kVerticesPerTriangle;
         ++vertexIndex) {
      const Vec3 vertex = {
          readF32LE(cursor),
          readF32LE(cursor + 4),
          readF32LE(cursor + 8),
      };
      vertices[vertexIndex] = vertex;

      result->positions[outIndex++] = vertex.x;
      result->positions[outIndex++] = vertex.y;
      result->positions[outIndex++] = vertex.z;
      cursor += kVertexBytes;
    }

    const Vec3 normal = normalizeOrFallback(stlNormal, computeTriangleNormal(vertices));
    const int normalIndex = outIndex - static_cast<int>(kFloatsPerTriangle);
    for (std::uint32_t vertexIndex = 0; vertexIndex < kVerticesPerTriangle;
         ++vertexIndex) {
      const int baseIndex =
          normalIndex + static_cast<int>(vertexIndex * kFloatsPerVertex);
      result->normals[baseIndex] = normal.x;
      result->normals[baseIndex + 1] = normal.y;
      result->normals[baseIndex + 2] = normal.z;
    }

    cursor += kAttributeBytes;
  }

  return result;
}

ParsedStlBuffers *parseAsciiStlInternal(const std::uint8_t *data, int length) {
  const std::uint8_t *cursor = data;
  const std::uint8_t *end = data + length;

  if (!consumeKeyword(cursor, end, "solid")) {
    return nullptr;
  }
  skipToLineEnd(cursor, end);

  std::vector<float> positions;
  std::vector<float> triangleNormals;
  const std::size_t roughTriangleCount =
      length > 0 ? static_cast<std::size_t>(length) / 128U : 0U;
  positions.reserve(roughTriangleCount * kFloatsPerTriangle);
  triangleNormals.reserve(roughTriangleCount * kFloatsPerVertex);

  while (true) {
    skipAsciiWhitespace(cursor, end);

    if (cursor >= end) {
      return nullptr;
    }

    if (matchesKeyword(cursor, end, "endsolid")) {
      consumeKeyword(cursor, end, "endsolid");
      skipToLineEnd(cursor, end);
      skipAsciiWhitespace(cursor, end);
      break;
    }

    if (!consumeKeyword(cursor, end, "facet") ||
        !consumeKeyword(cursor, end, "normal")) {
      return nullptr;
    }

    Vec3 stlNormal;
    if (!parseAsciiVec3(cursor, end, stlNormal)) {
      return nullptr;
    }

    if (!consumeKeyword(cursor, end, "outer") ||
        !consumeKeyword(cursor, end, "loop")) {
      return nullptr;
    }

    Vec3 vertices[kVerticesPerTriangle];
    for (std::uint32_t vertexIndex = 0; vertexIndex < kVerticesPerTriangle;
         ++vertexIndex) {
      if (!consumeKeyword(cursor, end, "vertex") ||
          !parseAsciiVec3(cursor, end, vertices[vertexIndex])) {
        return nullptr;
      }

      positions.push_back(vertices[vertexIndex].x);
      positions.push_back(vertices[vertexIndex].y);
      positions.push_back(vertices[vertexIndex].z);
    }

    if (!consumeKeyword(cursor, end, "endloop") ||
        !consumeKeyword(cursor, end, "endfacet")) {
      return nullptr;
    }

    const Vec3 normal = normalizeOrFallback(stlNormal, computeTriangleNormal(vertices));
    triangleNormals.push_back(normal.x);
    triangleNormals.push_back(normal.y);
    triangleNormals.push_back(normal.z);
  }

  if (triangleNormals.size() * kVerticesPerTriangle != positions.size()) {
    return nullptr;
  }

  if (positions.size() > static_cast<std::size_t>(std::numeric_limits<int>::max())) {
    return nullptr;
  }

  auto *result = allocateParsedStlBuffers(static_cast<int>(positions.size()));
  if (result == nullptr) {
    return nullptr;
  }

  if (result->floatCount == 0) {
    return result;
  }

  std::memcpy(result->positions, positions.data(),
              positions.size() * sizeof(float));

  for (std::size_t triangleIndex = 0; triangleIndex < triangleNormals.size() / 3U;
       ++triangleIndex) {
    const std::size_t normalBaseIndex = triangleIndex * 3U;
    const float normalX = triangleNormals[normalBaseIndex];
    const float normalY = triangleNormals[normalBaseIndex + 1U];
    const float normalZ = triangleNormals[normalBaseIndex + 2U];
    const std::size_t positionsBaseIndex =
        triangleIndex * static_cast<std::size_t>(kFloatsPerTriangle);

    for (std::uint32_t vertexIndex = 0; vertexIndex < kVerticesPerTriangle;
         ++vertexIndex) {
      const std::size_t outIndex =
          positionsBaseIndex + static_cast<std::size_t>(vertexIndex * kFloatsPerVertex);
      result->normals[outIndex] = normalX;
      result->normals[outIndex + 1U] = normalY;
      result->normals[outIndex + 2U] = normalZ;
    }
  }

  return result;
}

int computeFloatCount(const std::uint8_t *data, int length) {
  const StlFormat format = detectStlFormat(data, length);
  if (format == StlFormat::Invalid) {
    return kInvalidStlErrorCode;
  }

  if (format == StlFormat::Binary) {
    std::uint32_t triangleCount = 0;
    std::uint64_t requiredBytes = 0;
    if (!tryGetBinaryLayout(data, length, triangleCount, requiredBytes) ||
        requiredBytes > static_cast<std::uint64_t>(length)) {
      return kInvalidStlErrorCode;
    }

    const std::uint64_t floatCount =
        static_cast<std::uint64_t>(triangleCount) * kFloatsPerTriangle;
    if (floatCount > static_cast<std::uint64_t>(std::numeric_limits<int>::max())) {
      return kInvalidStlErrorCode;
    }

    return static_cast<int>(floatCount);
  }

  auto *result = parseAsciiStlInternal(data, length);
  if (result == nullptr) {
    return kInvalidStlErrorCode;
  }

  const int floatCount = result->floatCount;
  std::free(result->positions);
  std::free(result->normals);
  std::free(result);
  return floatCount;
}

} // namespace

extern "C" {

int getStlFloatCount(const std::uint8_t *data, int length) {
  return computeFloatCount(data, length);
}

int getBinaryStlFloatCount(const std::uint8_t *data, int length) {
  return computeFloatCount(data, length);
}

ParsedStlBuffers *parseStl(const std::uint8_t *data, int length) {
  switch (detectStlFormat(data, length)) {
  case StlFormat::Binary:
    return parseBinaryStlInternal(data, length);
  case StlFormat::Ascii:
    return parseAsciiStlInternal(data, length);
  case StlFormat::Invalid:
  default:
    return nullptr;
  }
}

ParsedStlBuffers *parseBinaryStl(const std::uint8_t *data, int length) {
  return parseStl(data, length);
}

float *getParsedStlPositions(const ParsedStlBuffers *result) {
  return result == nullptr ? nullptr : result->positions;
}

float *getParsedStlNormals(const ParsedStlBuffers *result) {
  return result == nullptr ? nullptr : result->normals;
}

int getParsedStlFloatCount(const ParsedStlBuffers *result) {
  return result == nullptr ? 0 : result->floatCount;
}

void freeParsedStl(ParsedStlBuffers *result) {
  if (result == nullptr) {
    return;
  }

  std::free(result->positions);
  std::free(result->normals);
  std::free(result);
}

} // extern "C"
