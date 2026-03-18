#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <limits>

namespace {

constexpr int kInvalidStlErrorCode = -1;
constexpr int kAsciiStlErrorCode = -2;
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
constexpr float kNormalEpsilon = 1.0e-12f;

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
  return static_cast<char>(std::tolower(static_cast<unsigned char>(byte)));
}

bool startsWithSolid(const std::uint8_t *data, int length) {
  if (data == nullptr || length < 5) {
    return false;
  }

  int offset = 0;
  while (offset < length && std::isspace(static_cast<unsigned char>(data[offset]))) {
    ++offset;
  }

  if (offset + 5 > length) {
    return false;
  }

  return lowerAscii(data[offset]) == 's' && lowerAscii(data[offset + 1]) == 'o' &&
         lowerAscii(data[offset + 2]) == 'l' && lowerAscii(data[offset + 3]) == 'i' &&
         lowerAscii(data[offset + 4]) == 'd';
}

bool containsFacetKeyword(const std::uint8_t *data, int length) {
  if (data == nullptr || length < 5) {
    return false;
  }

  const int scanLimit = length < 512 ? length : 512;

  for (int index = 0; index <= scanLimit - 5; ++index) {
    if (lowerAscii(data[index]) == 'f' && lowerAscii(data[index + 1]) == 'a' &&
        lowerAscii(data[index + 2]) == 'c' && lowerAscii(data[index + 3]) == 'e' &&
        lowerAscii(data[index + 4]) == 't') {
      return true;
    }
  }

  return false;
}

bool looksLikeAsciiStl(const std::uint8_t *data, int length) {
  if (!startsWithSolid(data, length)) {
    return false;
  }

  if (length < static_cast<int>(kBinaryStlPreambleBytes)) {
    return true;
  }

  const std::uint32_t triangleCount = readU32LE(data + kBinaryStlHeaderBytes);
  const std::uint64_t requiredBytes =
      static_cast<std::uint64_t>(kBinaryStlPreambleBytes) +
      static_cast<std::uint64_t>(triangleCount) * kTriangleRecordBytes;

  if (requiredBytes == static_cast<std::uint64_t>(length)) {
    return false;
  }

  return containsFacetKeyword(data, length);
}

int computeFloatCount(const std::uint8_t *data, int length) {
  if (data == nullptr || length < 0) {
    return kInvalidStlErrorCode;
  }

  if (looksLikeAsciiStl(data, length)) {
    return kAsciiStlErrorCode;
  }

  const auto byteLength = static_cast<std::uint64_t>(length);
  if (byteLength < kBinaryStlPreambleBytes) {
    return kInvalidStlErrorCode;
  }

  const std::uint32_t triangleCount = readU32LE(data + kBinaryStlHeaderBytes);
  const std::uint64_t requiredBytes =
      static_cast<std::uint64_t>(kBinaryStlPreambleBytes) +
      static_cast<std::uint64_t>(triangleCount) * kTriangleRecordBytes;

  if (requiredBytes > byteLength) {
    return kInvalidStlErrorCode;
  }

  const std::uint64_t floatCount =
      static_cast<std::uint64_t>(triangleCount) * kFloatsPerTriangle;
  if (floatCount > static_cast<std::uint64_t>(std::numeric_limits<int>::max())) {
    return kInvalidStlErrorCode;
  }

  return static_cast<int>(floatCount);
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

} // namespace

extern "C" {

int getBinaryStlFloatCount(const std::uint8_t *data, int length) {
  return computeFloatCount(data, length);
}

ParsedStlBuffers *parseBinaryStl(const std::uint8_t *data, int length) {
  const int floatCount = computeFloatCount(data, length);
  if (floatCount <= 0) {
    return nullptr;
  }

  auto *positions = static_cast<float *>(
      std::malloc(static_cast<std::size_t>(floatCount) * sizeof(float)));
  if (positions == nullptr) {
    return nullptr;
  }

  auto *normals = static_cast<float *>(
      std::malloc(static_cast<std::size_t>(floatCount) * sizeof(float)));
  if (normals == nullptr) {
    std::free(positions);
    return nullptr;
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

  const int triangleCount = floatCount / static_cast<int>(kFloatsPerTriangle);
  const std::uint8_t *cursor = data + kBinaryStlPreambleBytes;
  int outIndex = 0;

  for (int triangleIndex = 0; triangleIndex < triangleCount; ++triangleIndex) {
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

      positions[outIndex++] = vertex.x;
      positions[outIndex++] = vertex.y;
      positions[outIndex++] = vertex.z;
      cursor += kVertexBytes;
    }

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
    const Vec3 computedNormal = {
        edgeAB.y * edgeAC.z - edgeAB.z * edgeAC.y,
        edgeAB.z * edgeAC.x - edgeAB.x * edgeAC.z,
        edgeAB.x * edgeAC.y - edgeAB.y * edgeAC.x,
    };
    const Vec3 normal = normalizeOrFallback(stlNormal, computedNormal);

    const int normalIndex = outIndex - static_cast<int>(kFloatsPerTriangle);
    for (std::uint32_t vertexIndex = 0; vertexIndex < kVerticesPerTriangle;
         ++vertexIndex) {
      const int baseIndex =
          normalIndex + static_cast<int>(vertexIndex * kFloatsPerVertex);
      normals[baseIndex] = normal.x;
      normals[baseIndex + 1] = normal.y;
      normals[baseIndex + 2] = normal.z;
    }

    cursor += kAttributeBytes;
  }

  return result;
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
