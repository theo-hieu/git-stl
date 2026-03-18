#include <cmath>
#include <cstddef>
#include <limits>

namespace {

constexpr int kAnalyticsFloatCount = 7;

void scaleVertex(float *vertices, int index, float scaleX, float scaleY,
                 float scaleZ) {
  vertices[index] *= scaleX;
  vertices[index + 1] *= scaleY;
  vertices[index + 2] *= scaleZ;
}

void updateBounds(const float *vertices, int index, float &minX, float &minY,
                  float &minZ, float &maxX, float &maxY, float &maxZ) {
  const float x = vertices[index];
  const float y = vertices[index + 1];
  const float z = vertices[index + 2];

  if (x < minX) minX = x;
  if (y < minY) minY = y;
  if (z < minZ) minZ = z;
  if (x > maxX) maxX = x;
  if (y > maxY) maxY = y;
  if (z > maxZ) maxZ = z;
}

double accumulateTriangleVolume(const float *vertices, int index) {
  const double ax = static_cast<double>(vertices[index]);
  const double ay = static_cast<double>(vertices[index + 1]);
  const double az = static_cast<double>(vertices[index + 2]);
  const double bx = static_cast<double>(vertices[index + 3]);
  const double by = static_cast<double>(vertices[index + 4]);
  const double bz = static_cast<double>(vertices[index + 5]);
  const double cx = static_cast<double>(vertices[index + 6]);
  const double cy = static_cast<double>(vertices[index + 7]);
  const double cz = static_cast<double>(vertices[index + 8]);

  return (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) +
          az * (bx * cy - by * cx)) /
         6.0;
}

void writeAnalytics(float *analyticsOut, float minX, float minY, float minZ,
                    float maxX, float maxY, float maxZ, double signedVolume) {
  if (analyticsOut == nullptr) {
    return;
  }

  analyticsOut[0] = minX;
  analyticsOut[1] = minY;
  analyticsOut[2] = minZ;
  analyticsOut[3] = maxX;
  analyticsOut[4] = maxY;
  analyticsOut[5] = maxZ;
  analyticsOut[6] = static_cast<float>(std::abs(signedVolume));
}

} // namespace

extern "C" {

void scaleVerticesY(float *vertices, int length, float scale) {
  if (vertices == nullptr || length <= 0) {
    return;
  }

  for (int index = 1; index < length; index += 3) {
    vertices[index] *= scale;
  }
}

void scaleVertices(float *vertices, int length, float scaleX, float scaleY,
                   float scaleZ) {
  if (vertices == nullptr || length <= 0) {
    return;
  }

  for (int index = 0; index + 2 < length; index += 3) {
    scaleVertex(vertices, index, scaleX, scaleY, scaleZ);
  }
}

void scaleVerticesWithAnalytics(float *vertices, int length, float scaleX,
                                float scaleY, float scaleZ,
                                float *analyticsOut) {
  if (analyticsOut != nullptr) {
    for (int index = 0; index < kAnalyticsFloatCount; ++index) {
      analyticsOut[index] = 0.0f;
    }
  }

  if (vertices == nullptr || length <= 0 || analyticsOut == nullptr) {
    return;
  }

  float minX = std::numeric_limits<float>::infinity();
  float minY = std::numeric_limits<float>::infinity();
  float minZ = std::numeric_limits<float>::infinity();
  float maxX = -std::numeric_limits<float>::infinity();
  float maxY = -std::numeric_limits<float>::infinity();
  float maxZ = -std::numeric_limits<float>::infinity();
  double signedVolume = 0.0;

  for (int index = 0; index + 2 < length; index += 3) {
    scaleVertex(vertices, index, scaleX, scaleY, scaleZ);
    updateBounds(vertices, index, minX, minY, minZ, maxX, maxY, maxZ);
  }

  for (int index = 0; index + 8 < length; index += 9) {
    signedVolume += accumulateTriangleVolume(vertices, index);
  }

  writeAnalytics(analyticsOut, minX, minY, minZ, maxX, maxY, maxZ,
                 signedVolume);
}

} // extern "C"
